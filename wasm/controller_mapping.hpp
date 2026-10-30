#pragma once
// The button mapping and the stick calibration of the controllers (Settings > Input Settings > Button mapping). The
// front end (wasm/platform/button_mapping.js) passes them to startStream() as text, one line per controller:
//   <16 targets>;<calibration>;<id>
// - targets: for each button of the standard layout up to the D-pad (A, B, X, Y, LB, RB, LT, RT, Back, Start, LS, RS, Up,
//   Down, Left, Right), the standard button that it presses in the game, or -1 for none, separated by commas
// - calibration: nothing, or 12 numbers separated by commas: for the left stick, then the right stick, the centre of its
//   X and Y axis and the lowest and highest value of each axis (centreX, centreY, minX, maxX, minY, maxY)
// - id: the id of the controller as the stream sees it (the 63 bytes that the Emscripten event keeps), or * for every
//   controller without a line of its own. The id comes last, so that it may contain the separators.
// gamepad.cpp reads the buttons and sticks as the browser reports them, runs the button combos of the Stream Menu, the
// stop and the statistics on these physical buttons, and only then maps them with MapButtons() and CalibrateAxis(). The
// Guide button and the extra button 17 keep their meaning, and the menus of the app always see the physical buttons.
// There is no dead zone: a game applies its own, and a second one would widen it.
// Remapping per controller follows the fork of samirmartins (moonlight-tizen, 6a7ca6d, controller-mapping.js), the
// calibration of the centre and range of each stick the branch joystick-calibration of the fork of waresz (874e257 and
// 9940da6, gamepad.cpp), without its dead zone of 8 %. The header has no other dependencies, so the native tests can
// check it on its own (tests/native/controller_mapping_test.cpp).

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// The buttons of the standard layout that can be mapped: A (0) to D-pad right (15). LT (6) and RT (7) are analog.
constexpr int kMappedButtons = 16;
constexpr int kMappedLeftTrigger = 6;
constexpr int kMappedRightTrigger = 7;
// A button that presses nothing in the game
constexpr int kButtonUnmapped = -1;
// The number of bytes of a controller id that the Emscripten event keeps
constexpr size_t kControllerIdBytes = 63;
// The id of the line for every controller without a line of its own
constexpr const char* kAllControllersId = "*";
// The least distance from the centre to the end of an axis that a calibration may have. A shorter one would turn the
// noise of a stick at rest into large movements.
constexpr double kMinCalibratedRange = 0.25;
// The farthest that the centre of a calibrated axis may lie from 0
constexpr double kMaxCalibratedCentre = 0.5;

// The calibration of one stick: the centre of its axes and the lowest and highest value that each one reached
struct StickCalibration {
  bool valid = false;
  double centreX = 0.0;
  double centreY = 0.0;
  double minX = -1.0;
  double maxX = 1.0;
  double minY = -1.0;
  double maxY = 1.0;
};

struct ControllerMapping {
  std::string id;
  int targets[kMappedButtons];
  StickCalibration sticks[2]; // the left stick (axes 0 and 1) and the right stick (axes 2 and 3)

  ControllerMapping() {
    for (int i = 0; i < kMappedButtons; ++i) {
      targets[i] = i;
    }
  }
};

using ControllerMappings = std::vector<ControllerMapping>;

// Check that the values of one axis make a calibration: a centre near 0 and enough range on both sides of it
inline bool IsCalibratedAxis(double centre, double minimum, double maximum) {
  return std::isfinite(centre) && std::isfinite(minimum) && std::isfinite(maximum) &&
    std::fabs(centre) <= kMaxCalibratedCentre && minimum >= -1.0 && maximum <= 1.0 &&
    centre - minimum >= kMinCalibratedRange && maximum - centre >= kMinCalibratedRange;
}

// Read numbers separated by commas; false unless the text holds exactly `count` of them
inline bool ParseNumberList(const std::string& text, int count, double* values) {
  const char* cursor = text.c_str();
  for (int i = 0; i < count; ++i) {
    char* end = nullptr;
    values[i] = std::strtod(cursor, &end);
    if (end == cursor || (i + 1 < count && *end != ',') || (i + 1 == count && *end != '\0')) {
      return false;
    }
    cursor = end + 1;
  }
  return true;
}

// Read one line of the text. A line with a malformed list of targets or an empty id is left out; a malformed calibration
// only leaves out the calibration, and so does each stick whose values make no calibration (IsCalibratedAxis()).
inline bool ParseControllerMappingLine(const std::string& line, ControllerMapping* mapping) {
  const size_t first = line.find(';');
  const size_t second = first == std::string::npos ? std::string::npos : line.find(';', first + 1);
  if (second == std::string::npos || second + 1 >= line.size()) {
    return false;
  }
  double targets[kMappedButtons];
  if (!ParseNumberList(line.substr(0, first), kMappedButtons, targets)) {
    return false;
  }
  ControllerMapping result;
  for (int i = 0; i < kMappedButtons; ++i) {
    const double target = targets[i];
    if (target != std::floor(target) || target < kButtonUnmapped || target >= kMappedButtons) {
      return false;
    }
    result.targets[i] = static_cast<int>(target);
  }
  const std::string calibration = line.substr(first + 1, second - first - 1);
  double values[12];
  if (!calibration.empty() && ParseNumberList(calibration, 12, values)) {
    for (int stick = 0; stick < 2; ++stick) {
      const double* v = values + stick * 6;
      if (IsCalibratedAxis(v[0], v[2], v[3]) && IsCalibratedAxis(v[1], v[4], v[5])) {
        StickCalibration& c = result.sticks[stick];
        c.valid = true;
        c.centreX = v[0];
        c.centreY = v[1];
        c.minX = v[2];
        c.maxX = v[3];
        c.minY = v[4];
        c.maxY = v[5];
      }
    }
  }
  result.id = line.substr(second + 1, kControllerIdBytes);
  *mapping = result;
  return true;
}

// Read the text of the front end into one mapping per controller
inline ControllerMappings ParseControllerMappings(const std::string& text) {
  ControllerMappings mappings;
  size_t start = 0;
  while (start < text.size()) {
    size_t end = text.find('\n', start);
    if (end == std::string::npos) {
      end = text.size();
    }
    ControllerMapping mapping;
    if (ParseControllerMappingLine(text.substr(start, end - start), &mapping)) {
      mappings.push_back(mapping);
    }
    start = end + 1;
  }
  return mappings;
}

// The index of the mapping of a controller: its own line, else the line for every controller, else -1 (the buttons and
// sticks as they are)
inline int FindControllerMapping(const ControllerMappings& mappings, const char* id) {
  const std::string key = std::string(id ? id : "").substr(0, kControllerIdBytes);
  int all = -1;
  for (size_t i = 0; i < mappings.size(); ++i) {
    if (mappings[i].id == key) {
      return static_cast<int>(i);
    }
    if (mappings[i].id == kAllControllersId) {
      all = static_cast<int>(i);
    }
  }
  return all;
}

// The buttons as the game gets them, from the physical ones (pressed and their values from 0 to 1, of which there are
// `count`): each standard button is pressed when a button mapped to it is, and its value is the highest of theirs. A
// trigger mapped to a button presses it as far as the browser counts it pressed, and a button mapped to a trigger pulls
// it all the way.
inline void MapButtons(const int targets[kMappedButtons], const int* physicalPressed, const double* physicalValues,
                       int count, bool pressed[kMappedButtons], double values[kMappedButtons]) {
  for (int i = 0; i < kMappedButtons; ++i) {
    pressed[i] = false;
    values[i] = 0.0;
  }
  const int limit = std::min(count, kMappedButtons);
  for (int i = 0; i < limit; ++i) {
    const int target = targets[i];
    if (target < 0 || target >= kMappedButtons) {
      continue;
    }
    pressed[target] = pressed[target] || physicalPressed[i] != 0;
    values[target] = std::max(values[target], physicalValues[i]);
  }
}

// An axis value (-1 to 1) with the calibration of its stick: the centre becomes 0, and the lowest and highest values
// that it reached become -1 and 1. Without a calibration the value stays as it is.
inline double CalibrateAxis(double value, double centre, double minimum, double maximum) {
  const double scaled = value >= centre ? (value - centre) / (maximum - centre) : (value - centre) / (centre - minimum);
  return std::max(-1.0, std::min(1.0, scaled));
}
