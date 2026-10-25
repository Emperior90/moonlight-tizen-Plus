// Pins the controller type detection of wasm/controller_type.hpp on its own: the type that the stream announces to the
// host for a Gamepad.id, the vendor id it reads from the id, and the values of the setting "Controller type sent to
// the PC". The ids of tests/fixtures/controller-types.tsv are checked here and against getControllerType() of
// wasm/platform/gamepad.js (tests/unit/gamepad-js.test.js), so the menus show the type that the stream announces.

#include "controller_type.hpp"
#include "test_support.h"

#include <cstring>
#include <fstream>
#include <string>
#include <vector>

// The Emscripten event struct keeps 63 bytes of an id plus NUL (EM_HTML5_MEDIUM_STRING_LEN_BYTES)
static constexpr size_t kStreamIdLength = 63;

// The controller type for an id as the browser reports it, cut like the Emscripten event struct cuts it
static std::string TypeOf(const std::string& id) {
  return GetControllerTypeName(GetControllerType(id.substr(0, kStreamIdLength).c_str()));
}

struct TypeCase {
  std::string type;
  std::string id;
};

static std::vector<TypeCase> ReadTypeCases() {
  std::string path = __FILE__;
  path = path.substr(0, path.find_last_of('/') + 1) + "../fixtures/controller-types.tsv";
  std::ifstream file(path);
  std::vector<TypeCase> cases;
  std::string line;
  while (std::getline(file, line)) {
    const size_t tab = line.find('\t');
    if (line.empty() || line[0] == '#' || tab == std::string::npos) {
      continue;
    }
    cases.push_back({ line.substr(0, tab), line.substr(tab + 1) });
  }
  return cases;
}

static void TestFixtureTypes() {
  const std::vector<TypeCase> cases = ReadTypeCases();
  CHECK(cases.size() >= 20u);
  for (const TypeCase& entry : cases) {
    const std::string detected = TypeOf(entry.id);
    test_support::Check(detected == entry.type, "type of \"" + entry.id + "\"", "actual " + detected + ", expected " + entry.type,
                        __FILE__, __LINE__);
  }
  CHECK_EQ(static_cast<int>(GetControllerType(nullptr)), LI_CTYPE_UNKNOWN);
}

static void TestVendorIds() {
  using controller_type_detail::GetVendorId;
  // The Linux format of Chromium, with or without a space, and the vendor-product-name format
  CHECK_EQ(GetVendorId("dualsense wireless controller (standard gamepad vendor: 054c product: 0ce6)"), 0x054c);
  CHECK_EQ(GetVendorId("pad (vendor:2dc8 product:6001)"), 0x2dc8);
  CHECK_EQ(GetVendorId("045e-0b12-xbox wireless controller"), 0x045e);
  CHECK_EQ(GetVendorId("057e-2009-"), 0x057e);
  // No vendor, or a vendor that was cut off
  CHECK_EQ(GetVendorId("wireless controller"), -1);
  CHECK_EQ(GetVendorId("pad (standard gamepad vendor: 05"), -1);
  CHECK_EQ(GetVendorId("054c-wireless controller"), -1);
  CHECK_EQ(GetVendorId("abcd-12345-name"), -1);
  CHECK_EQ(GetVendorId(""), -1);
}

static void TestVendorBeforeNameHint() {
  // The vendor decides before a name hint: an 8BitDo controller in its Switch mode reports the vendor of Nintendo
  CHECK_EQ(TypeOf("8BitDo Pro 2 (Vendor: 057e Product: 2009)"), std::string("Nintendo"));
  // A vendor without a type of its own leaves the decision to the name
  CHECK_EQ(TypeOf("HORIPAD FPS for PlayStation 4 (Vendor: 0f0d Product: 0066)"), std::string("PlayStation"));
  CHECK_EQ(TypeOf("Generic X-Box pad (Vendor: 0e6f Product: 02a0)"), std::string("Xbox"));
  CHECK_EQ(TypeOf("HORI Nintendo Switch Pad (Vendor: 0f0d Product: 00c1)"), std::string("Nintendo"));
}

static void TestTypeNames() {
  CHECK_EQ(std::string(GetControllerTypeName(LI_CTYPE_PS)), std::string("PlayStation"));
  CHECK_EQ(std::string(GetControllerTypeName(LI_CTYPE_XBOX)), std::string("Xbox"));
  CHECK_EQ(std::string(GetControllerTypeName(LI_CTYPE_NINTENDO)), std::string("Nintendo"));
  CHECK_EQ(std::string(GetControllerTypeName(LI_CTYPE_UNKNOWN)), std::string("Unknown"));
}

static void TestSetting() {
  // The values of the setting, as the frontend sends them with the start request; Auto and anything else detect the type
  CHECK_EQ(static_cast<int>(GetControllerTypeFromSetting("Auto")), LI_CTYPE_UNKNOWN);
  CHECK_EQ(static_cast<int>(GetControllerTypeFromSetting("Xbox")), LI_CTYPE_XBOX);
  CHECK_EQ(static_cast<int>(GetControllerTypeFromSetting("PlayStation")), LI_CTYPE_PS);
  CHECK_EQ(static_cast<int>(GetControllerTypeFromSetting("Nintendo")), LI_CTYPE_NINTENDO);
  CHECK_EQ(static_cast<int>(GetControllerTypeFromSetting("")), LI_CTYPE_UNKNOWN);
  CHECK_EQ(static_cast<int>(GetControllerTypeFromSetting("playstation")), LI_CTYPE_UNKNOWN);
  // Each type name of the setting reads back as its type
  for (uint8_t type : { LI_CTYPE_XBOX, LI_CTYPE_PS, LI_CTYPE_NINTENDO }) {
    CHECK_EQ(static_cast<int>(GetControllerTypeFromSetting(GetControllerTypeName(type))), static_cast<int>(type));
  }
}

int main() {
  test_support::RunTest("controller type from the gamepad ids of the fixture", TestFixtureTypes);
  test_support::RunTest("vendor id from both id formats", TestVendorIds);
  test_support::RunTest("the vendor decides before a name hint", TestVendorBeforeNameHint);
  test_support::RunTest("controller type names", TestTypeNames);
  test_support::RunTest("controller type of the setting", TestSetting);
  return test_support::Summary();
}
