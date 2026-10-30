# Controllers

This page describes how Moonlight Plus handles game controllers: in the menus, during a stream, and what the PC gets. For setting up the app, see the [guide](GUIDE.md).

**Testing status:** the controller changes of Moonlight Plus (menus, controller type, rumble, mouse emulation, the Stream Menu combo, the button mapping and the stick calibration, the input test) were tested with simulated controllers and native tests of the controller code. None of them was checked with real controllers on a TV yet. Reports from real controllers are welcome on the [issue tracker of this fork](https://github.com/Emperior90/moonlight-tizen-Plus/issues).

## Contents

1. [Supported controllers](#1-supported-controllers)
2. [Controller modes](#2-controller-modes)
3. [Buttons in the menus](#3-buttons-in-the-menus)
4. [Buttons during a stream](#4-buttons-during-a-stream)
5. [Controller type sent to the PC](#5-controller-type-sent-to-the-pc)
6. [Rumble](#6-rumble)
7. [Mouse emulation](#7-mouse-emulation)
8. [Button mapping and stick calibration](#8-button-mapping-and-stick-calibration)
9. [Input test](#9-input-test)
10. [Known limits](#10-known-limits)

## 1. Supported controllers

The TV connects the controller, over USB or Bluetooth (pair it in the settings of the TV), and the app reads it through the Gamepad API of the browser of the TV. So a controller works when the TV supports it.

- The [FAQ of Moonlight Tizen](https://github.com/brightcraft/moonlight-tizen/wiki/Frequently-Asked-Questions) lists the controllers that Samsung supports officially: Xbox Series X|S, Xbox One, Xbox 360, Xbox Elite Wireless Series 2 and Xbox Adaptive controllers, DualShock 4 and DualSense, and some third-party models. Other controllers may work, but are not guaranteed to.
- According to the same FAQ, Samsung TVs support up to 4 controllers. Further controllers can be connected to the host PC directly, which may add input latency.
- Settings → About → *System information* lists every connected controller with its name, layout, buttons, axes, rumble support and controller type.

## 2. Controller modes

The app expects the standard layout of the Gamepad API, with the button positions of an Xbox controller: A at the bottom, B on the right, X on the left, Y at the top. The browser of the TV gives a controller this layout only when it knows the controller. Otherwise it reports the raw layout of the controller driver, and some buttons and sticks may be wrong.

- **Use the X-input or Xbox mode** of controllers that have several modes (e.g. 8BitDo controllers with X-input, D-input, Switch and macOS modes).
- When a controller reports a non-standard layout, the app shows a notice once per controller after it starts: "Gamepad N (name) has a non-standard button layout, so some buttons may be wrong. Try its XInput or Xbox mode, or another connection." This happens e.g. with an 8BitDo controller in D-input mode, or with a newer controller on a TV whose browser predates the mapping of that controller.
- System information shows *standard layout* or *non-standard layout* for each controller.
- The app can't fix a non-standard layout: the [button mapping](#8-button-mapping-and-stick-calibration) assumes the standard positions. The [input test](#9-input-test) shows which index each button of such a controller reports.

## 3. Buttons in the menus

The menus use the button positions (Xbox names first, PlayStation names in brackets):

| Button | Action |
|---|---|
| A (Cross) | Select the current item, like SELECT on the remote |
| B (Circle) | Back, like RETURN on the remote |
| D-pad, left stick | Move. Holding them repeats the move after 350 ms, then every 100 ms. Small stick movements are ignored. |
| Select / View (Share, Create) | Like CH+ on the remote: switch the mode of the host address field, and open the menu of the host PC or of the selected app ([app menu](GUIDE.md#16-stream-menu-and-app-menu)) |
| Start / Menu (Options) | Like CH- on the remote: set the focus on the current item |

- The in-app *Navigation guide* (Settings → About) lists the same buttons, with the remote and keyboard keys next to them.
- The [button mapping](#8-button-mapping-and-stick-calibration) only applies during a stream. In the menus, the bottom button always selects, also on Nintendo controllers, whose labels differ.
- Buttons that are still held when a stream ends (e.g. the stop combo) don't trigger anything in the menus.

## 4. Buttons during a stream

During a stream, the PC gets the buttons, sticks and analog triggers of every controller.

| Controller | PC |
|---|---|
| Standard buttons, sticks and triggers | The same buttons of the emulated controller, with the triggers as analog values |
| Guide button (Xbox, PS or Home button) | The Guide button, when the TV passes it to the app. Untested: some TVs may use it for their own menus. |
| Button 17: the touchpad click of PlayStation controllers, the Share button of Xbox Series controllers, the Capture button of Nintendo controllers | The touchpad button when the controller type is PlayStation, otherwise the misc button. Only announced for controllers that report 18 buttons or more. |

Settings → Input Settings:

- *Button mapping* lets each button press another one in games, for every controller or for one (see [section 8](#8-button-mapping-and-stick-calibration)). By default every button presses itself.
- The button combos below always use the physical buttons, whatever the button mapping.

**Button combos.** Hold exactly these buttons, and no others:

| Combo | Action |
|---|---|
| Select + Start, held for 1 second | Open the [Stream Menu](GUIDE.md#16-stream-menu-and-app-menu) (like the Play/Pause key of the remote) |
| Select + Start + LB + RB | End the stream (like the RED key of the remote) |
| Select + LB + RB + X | Step the performance statistics through Off, Compact and Full (like the YELLOW key) |

X means the left face button (Square on PlayStation controllers), whatever the button mapping.

**Select + Start for the Stream Menu.** Two buttons that every controller has, held together and alone, which none of the other combos uses on its own. So that the game doesn't react to the combo:

- Press both at the same time. While both are held, the game gets neither of them, and once the menu opened, it gets neither until you release them.
- A press of Select or Start alone reaches the game 0.1 seconds late (other buttons aren't delayed), so that the other button of the combo can still join it. A shorter press reaches the game right after its release, for as long as it was held. A press together with another button isn't the combo and reaches the game at once with that button, so a hotkey with Select as its modifier (e.g. Select + R1 in RetroArch) keeps its order.
- Select + Start released before the menu opened, e.g. the Select + Start hotkey of RetroArch, reach the game together afterwards, for as long as they were held.
- If one of them was held alone for longer than 0.1 seconds first, the game has it already: it sees that button held until the menu opens.
- Pressing LB + RB as well within the second ends the stream instead (the stop combo). The hold of Start for the mouse emulation never counts a hold of Select + Start.

**While the Stream Menu is open**, the PC gets every controller released (no buttons, sticks centred, triggers at 0) and no mouse buttons, and the controllers move through the menu like through the other menus (D-pad or left stick, A to choose, B back to the game). Buttons that are still held when the menu closes, e.g. A on *Resume*, reach the game only after you release them and press them again. Mouse mode stays as it was.

## 5. Controller type sent to the PC

When a stream starts, and whenever a controller connects during a stream, the app announces each controller to the PC with a controller type: Xbox, PlayStation, Nintendo or unknown. With its *gamepad* option on `auto` (the default), Sunshine uses this type to pick the controller it emulates on the PC, e.g. a PlayStation-style controller with PlayStation button prompts in games. For an unknown type it emulates an Xbox-style controller ([Sunshine configuration](https://github.com/LizardByte/Sunshine/blob/master/docs/configuration.md)).

**Auto detection** reads the name (id) that the browser reports for the controller:

1. The USB vendor in the id decides first: Sony gives PlayStation, Microsoft and 8BitDo give Xbox, Nintendo gives Nintendo. 8BitDo controllers report their own vendor in their X-input and D-input modes, and the vendor of the console in their Switch and macOS modes.
2. Without one of these vendors, the name decides: *DualSense*, *DualShock* or *PlayStation* give PlayStation, *Xbox*, *X-Box* or *8BitDo* give Xbox, *Nintendo* or *Joy-Con* give Nintendo.
3. Everything else is unknown.

The stream only sees the first 63 characters of the id, so a controller with a very long name may lose its vendor and stay unknown.

**The setting** Settings → Input Settings → *Controller type sent to the PC* (Auto, Xbox, PlayStation or Nintendo; Auto by default) overrides the detection for every controller, from the next stream on. Choose PlayStation, e.g., to get PlayStation button prompts and the touchpad button in games for a controller that the app doesn't detect, if the host supports it.

- System information shows the type sent to the PC for each controller. When the setting overrides the detection, it names the detected type as well, e.g. *PlayStation (setting, detected: Xbox)*.
- The log of the stream names the type sent to the PC in the same way. The log of the menus, when a controller connects, names the type that Auto detects.
- With a PlayStation-style controller emulated, Sunshine by default lets Select also trigger the touchpad click (its option `ds4_back_as_touchpad_click`).

## 6. Rumble

Settings → Input Settings → *Rumble feedback* (off by default).

- When it's on, a controller that connects plays a short rumble, so you can feel that rumble works.
- During a stream, the controller plays the rumble that the game sends. The TV ends every rumble effect after 5 seconds, so the app plays it again every 4 seconds until the game stops it.
- Rumble also stops when the stream ends and when the controller disconnects.
- The app only tells the PC that a controller can rumble when the setting is on and the controller has a vibration motor that the browser can use.
- A controller that can't rumble on the TV (it has no vibration motor for the browser, or the TV refuses the effect) gets a notice once: "Gamepad N (name) does not support rumble on this TV."
- Only the two main motors rumble. Trigger rumble isn't available.

## 7. Mouse emulation

Settings → Input Settings → *Mouse emulation* (off by default) lets a controller act as the mouse of the PC by holding Start.

- During a stream, hold Start for 1 second to switch mouse mode on or off. A notice says "Mouse emulation is activated" or "deactivated".
- The *Mouse emulation* entry of the [Stream Menu](GUIDE.md#16-stream-menu-and-app-menu) switches it as well, also with the setting off.
- It switches once per hold, so holding Start longer doesn't switch it back. A hold of Start together with Select, LB or RB, which belong to the button combos, never switches it.
- When a hold switches mouse mode off, the game doesn't get that Start. When a hold switches it on, the game sees Start held until the switch (from 0.1 seconds after the press, see the Stream Menu combo above, to 1 second), and then the controller released, so a game may open its pause menu.

In mouse mode:

| Controller | Mouse |
|---|---|
| Left stick | Moves the pointer, faster the further you push it |
| Right stick | Scrolls vertically and horizontally, faster the further you push it, up to 15 notches per second |
| A or LB | Left button |
| B or RB | Right button |
| X or Y | Middle button |

- Mouse mode applies to all controllers at once, and they share one mouse.
- While it is on, the game sees the controllers with nothing pressed and the sticks centred.
- The buttons follow the button mapping.
- Every stream starts without mouse mode.

## 8. Button mapping and stick calibration

Settings → Input Settings → *Button mapping*. Each of the 16 buttons of the standard layout up to the D-pad (A, B, X, Y, LB, RB, LT, RT, Select, Start, the two stick buttons and the D-pad) can press another one of them in games, or none.

- The first row chooses the controller with LEFT and RIGHT: *All controllers*, then each connected controller, then the controllers that have a mapping of their own. Each other row is a button of the controller, with the button it presses between the arrows; LEFT and RIGHT (or OK) change it, and a changed button shows in amber. A gamepad works the same way: D-pad to move and change, A to step, B to close.
- A controller without a mapping of its own uses the one of *All controllers*. Changing one of its buttons gives it its own mapping, which is stored under its id, so two controllers of the same model share it. *Reset this controller* forgets it again (for *All controllers*: every button presses itself again).
- The mapping applies from the next stream. The menus of the app always use the buttons as printed.
- The [button combos](#4-buttons-during-a-stream) (Stream Menu, stop, statistics) and the hold of Start for the mouse emulation run on the physical buttons before the mapping, so they work whatever the mapping. A button mapped to Start doesn't make a Stream Menu combo with Select.
- A trigger mapped to a button presses it as far as the TV counts the trigger pressed, and a button mapped to a trigger pulls it all the way. The Guide button and button 17 keep their meaning.
- Restore Defaults resets the mapping and every calibration.
- The earlier switches *Flip A/B face buttons* and *Flip X/Y face buttons* became the mapping of *All controllers*: an install that had them on keeps A/B or X/Y swapped.

**Stick calibration.** For worn or cheap sticks that rest off-centre or don't reach the edge, choose the connected controller and *Calibrate the sticks*:

1. Leave both sticks at rest and press OK: the centre is the average of the last half second.
2. Move both sticks slowly around their edge two or three times and press OK: the ends are the lowest and highest values each axis reached.

During the stream the centre then counts as 0 and the ends as full deflection. A stick whose centre lies more than half way off, or that moved less than a quarter of the way to a side, isn't calibrated. There is no dead zone: games apply their own, and a second one would widen it. RETURN cancels the calibration.

## 9. Input test

Settings → Input Settings → *Input test* shows what reaches the app:

- every key of the remote or a keyboard with its name, key code and how long it was held, also how often it repeated, and the last 8 keys;
- each connected controller, drawn live: pressed buttons, how far each trigger is pulled, where each stick is, and the values of its buttons and axes (a controller with a non-standard layout names its buttons by their index);
- the media and colour keys of the TV, those that Moonlight registered and those that it leaves to the TV (from `tizen.tvinputdevice.getSupportedKeys()`).

The test takes every key itself, so OK, the arrows and the colour keys do nothing else. RETURN (or ESC) shows and then leaves it; on a controller, hold B for 2 seconds. The controllers are only read while it is open, and it registers no keys of its own: a key that doesn't show is one that the TV doesn't pass to the app.

## 10. Known limits

- **Not available:** the touchpad surface, motion sensors, the battery level and the lights of a controller. The Gamepad API of the browser of the TV doesn't provide them, so the app doesn't announce them to the PC. The upstream FAQ also lists motion controls as unsupported because of a Tizen platform limitation. Only the touchpad click works (as button 17).
- **Non-standard layouts** can't be fixed in the app. Try another mode or connection of the controller.
- **Nintendo controllers:** the menus and the stream use the button positions, so the labels A/B and X/Y are swapped compared to the controller. Use the [button mapping](#8-button-mapping-and-stick-calibration) for the stream.
- **Guide button:** whether the TV passes it to the app is untested.
- **Untested on real hardware:** the touchpad click of PlayStation controllers, rumble longer than 5 seconds, mouse emulation with two controllers, the controller type setting with Sunshine, the button mapping and the stick calibration with real controllers, and controllers in other modes (e.g. the D-input mode of 8BitDo controllers).
