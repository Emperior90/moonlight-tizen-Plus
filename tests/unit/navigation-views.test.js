'use strict';

// Pins what wasm/platform/navigation.js does since 2.3.1 so that the selection of a menu or dialog is always the one
// that shows, and one press opens one thing:
// - a list that got shorter selects its last item, and UP and DOWN step over the options of a drop-down that can't be
//   chosen;
// - a view that is already on top isn't pushed a second time, a drop-down ignores OK for 300 ms after it opened unless a
//   key moved the selection meanwhile, the view of a drop-down that something else closed goes with the next key, and a
//   dialog closes an open drop-down first;
// - UP and DOWN on the buttons of the Add PC dialog, UP in the dialogs with one button, CH+ on the menu icon of a PC, and
//   the views whose list can be empty.
// navigation.js runs here on a small stand-in for the page; tests/browser/ drives the real page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlatformScripts } = require('./helpers/platform-loader');

// A stand-in for an element of the page, which the context knows as HTMLElement
class FakeElement {
  constructor(id, options) {
    const opts = options || {};
    this.id = id || '';
    this.tagName = opts.tagName || 'BUTTON';
    this.attributes = Object.assign({}, opts.attributes);
    this.classes = new Set(opts.classes || []);
    this.children = opts.children || [];
    this.value = opts.value;
    this.checked = !!opts.checked;
    this.disabled = false;
    this.readOnly = false;
    this.events = [];
    this.clicks = 0;
    this.page = opts.page || null;
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }

  dispatchEvent(event) {
    this.events.push(event.type);
    return true;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  getAttribute(name) {
    return this.hasAttribute(name) ? this.attributes[name] : null;
  }

  focus() {
    if (this.page) {
      this.page.activeElement = this;
    }
  }

  blur() {
    if (this.page && this.page.activeElement === this) {
      this.page.activeElement = this.page.body;
    }
  }

  click() {
    this.clicks++;
  }

  closest() {
    return null;
  }

  querySelector() {
    return null;
  }
}

// Load navigation.js on a page with the given elements (by id), a clock for performance.now() and a console that
// records the errors. `visibleMenus` are the containers of the drop-downs that show.
function loadNavigation(elementIds) {
  const page = { elements: {}, activeElement: null, visibleMenus: [], escapes: 0 };
  page.body = new FakeElement('body', { page, tagName: 'BODY' });
  page.activeElement = page.body;
  const add = (id, options) => {
    page.elements[id] = new FakeElement(id, Object.assign({ page }, options));
    return page.elements[id];
  };
  (elementIds || []).forEach((id) => add(id));
  add('listener', { tagName: 'DIV' });
  let now = 1000;
  const platform = loadPlatformScripts(['wasm/platform/navigation.js'], {
    globals: {
      HTMLElement: FakeElement,
      Event: function(type) { this.type = type; },
      MouseEvent: function(type) { this.type = type; },
      KeyboardEvent: function(type) { this.type = type; },
      performance: { now: () => now },
      requestAnimationFrame: () => 0,
      document: {
        getElementById: (id) => page.elements[id] || null,
        querySelector: () => null,
        querySelectorAll: (selector) => (selector === '.mdl-menu__container.is-visible' ? page.visibleMenus.slice() : []),
        dispatchEvent: () => { page.escapes++; return true; },
        get activeElement() { return page.activeElement; },
        get body() { return page.body; },
      },
    },
  });
  const errors = () => platform.consoleMessages.filter((message) => message.level === 'error').map((message) => message.text);
  return { platform, page, add, errors, advance: (ms) => { now += ms; }, Views: platform.get('Views'), Navigation: platform.get('Navigation') };
}

// A view that records its operations, with the given list of items
function recordingView(nav, name, log, items, extra) {
  nav.platform.context.__items = items;
  const view = nav.platform.run('({ view: new ListView(() => __items) })');
  ['up', 'down', 'left', 'right', 'accept', 'back', 'press', 'switch', 'enter', 'leave'].forEach((operation) => {
    view[operation] = () => log.push(name + '.' + operation);
  });
  return Object.assign(view, extra || {});
}

const marked = (nav) => Object.keys(nav.page.elements).filter((id) => nav.page.elements[id].classes.has('hovered'));

test('a list that got shorter selects its last item instead of nothing', () => {
  const nav = loadNavigation(['a', 'b', 'c']);
  nav.platform.context.__items = ['a', 'b', 'c'];
  const list = nav.platform.run('new ListView(() => __items)');
  list.index = 2;
  assert.equal(list.current(), 'c');
  // A row of the settings that another setting hides, e.g. 'Decrypt host audio' without audio (undefined before 2.3.1)
  nav.platform.context.__items = ['a', 'b'];
  assert.equal(list.current(), 'b');
  assert.equal(list.index, 1);
  // An empty list has no selection and keeps the index for the items that come back
  nav.platform.context.__items = [];
  assert.equal(list.current(), undefined);
  assert.equal(list.index, 1);
  assert.equal(list.nextOption(), undefined);
  assert.deepEqual(nav.errors(), []);
});

test('select() moves the mark with the selection', () => {
  const nav = loadNavigation(['a', 'b', 'c']);
  nav.platform.context.__items = ['a', 'b', 'c'];
  const list = nav.platform.run('new ListView(() => __items)');
  nav.platform.get('mark')('a');
  assert.equal(list.select(2), 'c');
  assert.deepEqual(marked(nav), ['c']);
  assert.deepEqual(nav.page.elements.a.events, ['mouseenter', 'mouseleave']);
  // The item that is selected already and an index outside the list change nothing
  assert.equal(list.select(2), 'c');
  assert.equal(list.select(3), 'c');
  assert.equal(list.select(-1), 'c');
  assert.deepEqual(nav.page.elements.c.events, ['mouseenter']);
  assert.deepEqual(marked(nav), ['c']);
});

test('UP and DOWN step over the options of a drop-down that are disabled, around the ends of the list', () => {
  const nav = loadNavigation();
  // The resolutions of a Full HD TV: 1440p, 1800p and 4K are [Unsupported]
  const option = (value, disabled) => new FakeElement('', { tagName: 'LI', classes: ['mdl-menu__item'], attributes: Object.assign({ 'data-value': value }, disabled ? { disabled: 'disabled' } : {}) });
  const options = [option('480p'), option('720p'), option('1080p'), option('1440p', true), option('1800p', true), option('4K', true)];
  nav.platform.context.__items = options;
  const list = nav.platform.run('new ListView(() => __items)');
  const value = (item) => item.getAttribute('data-value');
  list.index = 2;
  // DOWN from 1080p goes around to 480p (to the disabled 1440p before 2.3.1), UP from 480p back to 1080p
  assert.equal(value(list.nextOption()), '480p');
  assert.equal(value(list.prevOption()), '1080p');
  assert.equal(value(list.prevOption()), '720p');
  assert.equal(value(list.nextOption()), '1080p');
  assert.ok(options[2].classes.has('hovered'));
  assert.equal(options.filter((item) => item.classes.has('hovered')).length, 1);
  // A list of rows by id, and a list with one option that can be chosen
  nav.add('row1');
  nav.add('row2');
  nav.platform.context.__items = ['row1', 'row2'];
  const rows = nav.platform.run('new ListView(() => __items)');
  assert.equal(rows.nextOption(), 'row2');
  assert.equal(rows.nextOption(), 'row1');
  nav.platform.context.__items = [option('a', true), option('b'), option('c', true)];
  const single = nav.platform.run('new ListView(() => __items)');
  single.index = 1;
  assert.equal(value(single.nextOption()), 'b');
  assert.equal(value(single.prevOption()), 'b');
  assert.deepEqual(nav.errors(), []);
});

test('a view that is already on top is not pushed a second time', () => {
  const nav = loadNavigation();
  const log = [];
  const hosts = recordingView(nav, 'Hosts', log, []);
  const menu = recordingView(nav, 'HostMenu', log, []);
  nav.Navigation.start();
  nav.Navigation.push(hosts);
  // Two CH+ on a PC, or two OK on Check for updates: the second push left a second copy, which took the keys after Close
  nav.Navigation.push(menu, 'GAMING-PC');
  nav.Navigation.push(menu, 'OTHER-PC');
  assert.deepEqual(log, ['Hosts.enter', 'Hosts.leave', 'HostMenu.enter']);
  assert.equal(menu.hostname, 'GAMING-PC');
  nav.Navigation.pop();
  assert.deepEqual(log.slice(3), ['HostMenu.leave', 'Hosts.enter']);
  // The keys are back in the view below (the first key gives the navigation its focus)
  log.length = 0;
  nav.Navigation.down();
  nav.Navigation.down();
  assert.deepEqual(log, ['Hosts.enter', 'Hosts.down']);
  // The same view may come again later, and over another view
  nav.Navigation.push(menu);
  nav.Navigation.push(hosts);
  nav.Navigation.push(menu);
  log.length = 0;
  nav.Navigation.pop();
  nav.Navigation.pop();
  nav.Navigation.pop();
  assert.deepEqual(log, ['HostMenu.leave', 'Hosts.enter', 'Hosts.leave', 'HostMenu.enter', 'HostMenu.leave', 'Hosts.enter']);
});

test('a view that asked for it ignores OK for 300 ms after it opened, and nothing else', () => {
  const nav = loadNavigation();
  assert.equal(nav.platform.get('ACCEPT_GUARD_MS'), 300);
  const log = [];
  const settings = recordingView(nav, 'Settings', log, []);
  const dropdown = recordingView(nav, 'Menu', log, [], { isActive: () => true });
  nav.Navigation.start();
  nav.Navigation.push(settings);
  nav.Navigation.accept();
  nav.Navigation.guardAccept(dropdown);
  nav.Navigation.push(dropdown);
  log.length = 0;
  // The second press of a double OK, 120 ms after the first (it chose the option under the selection before 2.3.1)
  nav.advance(120);
  nav.Navigation.accept();
  assert.deepEqual(log, []);
  // The other keys act at once
  nav.Navigation.back();
  nav.Navigation.press();
  assert.deepEqual(log, ['Menu.back', 'Menu.press']);
  nav.advance(179);
  nav.Navigation.accept();
  assert.deepEqual(log, ['Menu.back', 'Menu.press']);
  nav.advance(1);
  nav.Navigation.accept();
  assert.deepEqual(log, ['Menu.back', 'Menu.press', 'Menu.accept']);
  // A view that didn't ask takes OK at once, also one that asked the last time it opened
  nav.Navigation.pop();
  log.length = 0;
  nav.Navigation.accept();
  nav.advance(5000);
  nav.Navigation.push(dropdown);
  nav.Navigation.accept();
  assert.deepEqual(log, ['Settings.accept', 'Settings.leave', 'Menu.enter', 'Menu.accept']);
});

test('a key that moves the selection ends the guard of OK, so that OK chooses at once after it', () => {
  const nav = loadNavigation();
  const log = [];
  const settings = recordingView(nav, 'Settings', log, []);
  const dropdown = recordingView(nav, 'Menu', log, [], { isActive: () => true });
  nav.Navigation.start();
  nav.Navigation.push(settings);
  // The first key gives the navigation its focus
  nav.Navigation.accept();
  // OK opens the drop-down, DOWN 120 ms later moves to another option, and OK 250 ms after the first chooses it: the
  // menu stayed open with the option highlighted and needed a third OK before
  for (const move of ['up', 'down', 'left', 'right']) {
    nav.Navigation.guardAccept(dropdown);
    nav.Navigation.push(dropdown);
    log.length = 0;
    nav.advance(120);
    nav.Navigation[move]();
    nav.advance(130);
    nav.Navigation.accept();
    assert.deepEqual(log, ['Menu.' + move, 'Menu.accept'], move);
    nav.Navigation.pop();
  }
  // RETURN and the other keys that don't move the selection leave the guard as it is
  nav.Navigation.guardAccept(dropdown);
  nav.Navigation.push(dropdown);
  log.length = 0;
  nav.advance(120);
  nav.Navigation.press();
  nav.Navigation.switch();
  nav.Navigation.accept();
  assert.deepEqual(log, ['Menu.press', 'Menu.switch']);
  nav.Navigation.pop();

  // The drop-down still counts as just opened for its options, which a busy TV may show late: two moves before they
  // show stay in it, and the next guard starts without the move of the last one
  let isMenuShown = false;
  const slow = recordingView(nav, 'Slow', log, [], { isActive: () => isMenuShown });
  nav.Navigation.guardAccept(slow);
  nav.Navigation.push(slow);
  log.length = 0;
  nav.advance(120);
  nav.Navigation.down();
  nav.advance(100);
  nav.Navigation.down();
  assert.deepEqual(log, ['Slow.down', 'Slow.down']);
  isMenuShown = true;
  nav.Navigation.pop();
  nav.Navigation.guardAccept(slow);
  nav.Navigation.push(slow);
  log.length = 0;
  nav.advance(120);
  nav.Navigation.accept();
  assert.deepEqual(log, []);
  assert.deepEqual(nav.errors(), []);
});

test('the view of a drop-down that something else closed goes with the next key, which acts on the row', () => {
  const nav = loadNavigation();
  const log = [];
  let isMenuShown = true;
  const settings = recordingView(nav, 'Settings', log, []);
  const dropdown = recordingView(nav, 'Menu', log, [], { isActive: () => isMenuShown });
  nav.Navigation.start();
  nav.Navigation.push(settings);
  nav.Navigation.accept();
  nav.Navigation.guardAccept(dropdown);
  nav.Navigation.push(dropdown);
  // Right after it opened the options don't show yet (the menu shows them with the next frame): the view stays
  isMenuShown = false;
  log.length = 0;
  nav.Navigation.down();
  assert.deepEqual(log, ['Menu.down']);
  isMenuShown = true;
  nav.advance(400);
  nav.Navigation.down();
  assert.deepEqual(log, ['Menu.down', 'Menu.down']);
  // A click beside the drop-down closed it: OK used to choose an option of the hidden drop-down, and RETURN did nothing
  isMenuShown = false;
  log.length = 0;
  nav.Navigation.accept();
  assert.deepEqual(log, ['Menu.leave', 'Settings.enter', 'Settings.accept']);
  nav.Navigation.back();
  assert.deepEqual(log.slice(3), ['Settings.back']);

  // After a move of the mouse the first key only brings the selection back: to the row, not to the hidden drop-down
  isMenuShown = true;
  nav.Navigation.push(dropdown);
  nav.advance(400);
  nav.platform.windowListeners.mousemove.forEach((listener) => listener({ type: 'mousemove' }));
  isMenuShown = false;
  log.length = 0;
  nav.Navigation.down();
  assert.deepEqual(log, ['Menu.leave', 'Settings.enter', 'Settings.enter']);
  nav.Navigation.down();
  assert.deepEqual(log.slice(3), ['Settings.down']);
});

test('a dialog that opens over a drop-down closes it first', () => {
  const nav = loadNavigation();
  const log = [];
  let hidden = 0;
  const container = { querySelector: () => ({ MaterialMenu: { hide: () => { hidden++; nav.page.visibleMenus = []; } } }) };
  const settings = recordingView(nav, 'Settings', log, []);
  const dropdown = recordingView(nav, 'Menu', log, [], { isActive: () => nav.page.visibleMenus.length > 0 });
  const dialog = recordingView(nav, 'Dialog', log, []);
  nav.Navigation.start();
  nav.Navigation.push(settings);
  nav.Navigation.accept();
  // The drop-down shows when the answer of a check for updates, a pairing PIN or an error opens its dialog: the keys
  // stayed in the drop-down behind the dialog before 2.3.1, also after the dialog was closed
  nav.page.visibleMenus = [container];
  nav.Navigation.push(dropdown);
  log.length = 0;
  nav.Navigation.push(dialog);
  assert.equal(hidden, 1);
  assert.equal(nav.page.body.clicks, 1, 'the click that the drop-down closes on');
  assert.deepEqual(log, ['Menu.leave', 'Settings.enter', 'Settings.leave', 'Dialog.enter']);
  nav.Navigation.accept();
  nav.Navigation.pop();
  nav.Navigation.down();
  assert.deepEqual(log.slice(4), ['Dialog.accept', 'Dialog.leave', 'Settings.enter', 'Settings.down']);

  // A drop-down that something else closed already only loses its view
  nav.Navigation.push(dropdown);
  log.length = 0;
  nav.Navigation.push(dialog);
  assert.equal(hidden, 1);
  assert.deepEqual(log, ['Menu.leave', 'Settings.enter', 'Settings.leave', 'Dialog.enter']);
  // A dialog over a view that is no drop-down leaves it where it is
  nav.Navigation.pop();
  log.length = 0;
  nav.Navigation.push(dialog);
  assert.deepEqual(log, ['Settings.leave', 'Dialog.enter']);
});

// The Add PC dialog with its number fields or its text field, opened on its first item
function openAddPcDialog(numberFields) {
  const nav = loadNavigation(['continueAddHost', 'cancelAddHost']);
  nav.add('ipAddressFieldModeSwitch', { tagName: 'INPUT', checked: numberFields });
  nav.add('ipAddressTextInput', { tagName: 'INPUT' });
  [192, 168, 0, 7].forEach((number, index) => nav.add('ipAddressField' + (index + 1), { tagName: 'SELECT', value: String(number) }));
  const view = nav.Views.AddHostDialog;
  view.view.index = 0;
  nav.platform.get('mark')(view.view.current());
  return { nav, view, select: (id) => view.view.select(view.view.func().indexOf(id)), current: () => view.view.current() };
}

test('Add PC with the number fields: UP and DOWN change a number and do nothing on Continue and Cancel', () => {
  const { nav, view, select, current } = openAddPcDialog(true);
  const numbers = () => [1, 2, 3, 4].map((n) => nav.page.elements['ipAddressField' + n].value).join('.');
  select('ipAddressField4');
  view.up();
  view.up();
  view.down();
  assert.equal(numbers(), '192.168.0.8');
  ['continueAddHost', 'cancelAddHost'].forEach((button) => {
    select(button);
    // DOWN went to the second number and UP to the first one, while the button kept the mark (before 2.3.1)
    view.down();
    assert.equal(current(), button);
    view.up();
    assert.equal(current(), button);
    assert.deepEqual(marked(nav), [button]);
  });
  assert.equal(numbers(), '192.168.0.8');
  // LEFT and RIGHT are the way between the fields and the buttons, with the mark
  view.left();
  view.left();
  assert.equal(current(), 'ipAddressField4');
  assert.deepEqual(marked(nav), ['ipAddressField4']);
  assert.deepEqual(nav.errors(), []);
});

test('Add PC with the text field: DOWN goes to Continue and UP back to the address, with the mark', () => {
  const { nav, view, select, current } = openAddPcDialog(false);
  assert.equal(current(), 'ipAddressTextInput');
  view.down();
  assert.equal(current(), 'continueAddHost');
  assert.deepEqual(marked(nav), ['continueAddHost']);
  assert.equal(nav.page.activeElement.id, 'continueAddHost');
  // DOWN on a button stays there
  view.down();
  assert.equal(current(), 'continueAddHost');
  select('cancelAddHost');
  view.down();
  assert.equal(current(), 'cancelAddHost');
  view.up();
  assert.equal(current(), 'ipAddressTextInput');
  assert.deepEqual(marked(nav), ['ipAddressTextInput'], 'the mark stayed on the button before 2.3.1');
  view.up();
  assert.equal(current(), 'ipAddressTextInput');
  assert.deepEqual(nav.errors(), []);
});

test('UP keeps the focus on the only button of a dialog', () => {
  const dialogs = {
    PairingDialog: 'cancelPairing', HostDetailsDialog: 'closeHostDetails', MoonlightSupportDialog: 'closeAppSupport',
    NavigationGuideDialog: 'closeNavGuide', UpdateMoonlightDialog: 'closeUpdateApp',
  };
  const nav = loadNavigation(Object.keys(dialogs).map((name) => dialogs[name]));
  Object.keys(dialogs).forEach((name) => {
    const view = nav.Views[name];
    assert.deepEqual(Array.from(view.view.func()), [dialogs[name]]);
    view.switch();
    assert.equal(nav.page.activeElement.id, dialogs[name]);
    // UP took the focus off the button, so that nothing looked selected while OK still pressed it (before 2.3.1)
    view.up();
    assert.equal(nav.page.activeElement.id, dialogs[name], name);
    view.down();
    assert.equal(nav.page.activeElement.id, dialogs[name], name);
  });
});

test('the Wake PC dialog moves between the switch, by its label that shows the mark, and Cancel', () => {
  const nav = loadNavigation(['autoWolCheckboxBtn', 'cancelAutoWol']);
  const view = nav.Views.AutoWolDialog;
  assert.deepEqual(Array.from(view.view.func()), ['autoWolCheckboxBtn', 'cancelAutoWol']);
  // The dialog opens on Cancel (autoWolDialog() in index.js sets the index)
  view.view.index = 1;
  view.enter();
  assert.deepEqual(marked(nav), ['cancelAutoWol']);
  view.down();
  assert.equal(view.view.current(), 'cancelAutoWol');
  view.up();
  assert.equal(view.view.current(), 'autoWolCheckboxBtn');
  assert.deepEqual(marked(nav), ['autoWolCheckboxBtn']);
  view.up();
  assert.equal(view.view.current(), 'autoWolCheckboxBtn');
  view.down();
  assert.deepEqual(marked(nav), ['cancelAutoWol']);
});

// The PC list with Add PC and one PC, whose card has a menu icon
function loadHostGrid() {
  const nav = loadNavigation();
  const menuButton = nav.add('hostMenuButton-HOST1');
  const card = nav.add('host-container-HOST1', { tagName: 'DIV', children: [nav.add('hostgrid-HOST1'), menuButton] });
  const grid = nav.add('host-grid', { tagName: 'DIV', children: [nav.add('addHostContainer', { tagName: 'DIV' }), card] });
  return { nav, grid, card, menuButton };
}

test('CH+ and Select on the menu icon of a PC open its menu like OK', () => {
  const { nav, menuButton } = loadHostGrid();
  nav.Views.Hosts.view.index = 1;
  nav.Views.HostsMenuHighlight.accept();
  assert.equal(menuButton.clicks, 1);
  // They did nothing before 2.3.1
  nav.Views.HostsMenuHighlight.press();
  assert.equal(menuButton.clicks, 2);
  // Nothing to open on Add PC
  nav.Views.Hosts.view.index = 0;
  nav.Views.HostsMenuHighlight.press();
  assert.equal(menuButton.clicks, 2);
});

test('the views whose list can be empty enter and leave without an error', () => {
  const { nav, grid } = loadHostGrid();
  // The app list is entered before the tiles of the PC exist: 'Cannot mark the unresolved target: undefined' in the
  // log at every opening of an app list before 2.3.1
  nav.add('game-grid', { tagName: 'DIV', children: [] });
  nav.Views.Apps.enter();
  nav.Views.Apps.leave();
  // The menu icon of a PC that was deleted from its menu
  nav.Views.Hosts.view.index = 1;
  nav.Views.HostsMenuHighlight.enter();
  assert.deepEqual(marked(nav), ['hostMenuButton-HOST1']);
  nav.Views.HostsMenuHighlight.leave();
  grid.children = [grid.children[0]];
  nav.Views.Hosts.view.reset();
  nav.Views.HostsMenuHighlight.enter();
  nav.Views.HostsMenuHighlight.leave();
  assert.deepEqual(marked(nav), []);
  assert.deepEqual(nav.errors(), []);
  // The tiles get the mark once they are there
  const tile = nav.add('game-container-101', { tagName: 'DIV' });
  nav.page.elements['game-grid'].children = [tile];
  nav.Views.Apps.enter();
  assert.deepEqual(marked(nav), ['game-container-101']);
});
