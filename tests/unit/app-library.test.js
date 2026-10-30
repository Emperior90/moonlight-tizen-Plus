'use strict';

// Checks the favorites, the recently played apps and the order of the app list (wasm/platform/menus.js): orderAppList()
// puts the favorites first and orders each part by title (A to Z, Z to A), by the recently played apps or as the host
// lists them, without relying on Array.prototype.sort() keeping the order of equal elements (the browser of Tizen 5.5,
// Chromium 69, doesn't); the favorites and the recently played apps are stored per host, and an entry is an app by its
// title (by its ID only without a title), so that apps a host numbered anew or two apps with one title are never mixed
// up; the setting reads the true and false of the switch of earlier versions. The browser test
// tests/browser/app-library.test.js runs them in the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPlatformScripts, plain } = require('./helpers/platform-loader');

function loadMenus() {
  return loadPlatformScripts(['wasm/platform/menus.js']);
}

// The apps of a host in the order it lists them
const HOST_APPS = [
  { id: 11, title: 'Desktop' }, { id: 12, title: 'Steam Big Picture' }, { id: 13, title: 'Cyberpunk 2077' },
  { id: 14, title: 'Forza Horizon 5' }, { id: 15, title: 'alan wake 2' }, { id: 16, title: 'Game 10' }, { id: 17, title: 'Game 9' },
];
const titles = (list) => plain(list).map((app) => app.title);

test('the orders of the setting: A to Z and Z to A by title (numbers by value, without regard to case), or as the host lists them', () => {
  const menus = loadMenus();
  const order = (sortOrder) => titles(menus.get('orderAppList')(HOST_APPS, sortOrder, [], []));
  assert.deepEqual(order('az'), ['alan wake 2', 'Cyberpunk 2077', 'Desktop', 'Forza Horizon 5', 'Game 9', 'Game 10', 'Steam Big Picture']);
  assert.deepEqual(order('za'), ['Steam Big Picture', 'Game 10', 'Game 9', 'Forza Horizon 5', 'Desktop', 'Cyberpunk 2077', 'alan wake 2']);
  assert.deepEqual(order('host'), HOST_APPS.map((app) => app.title));
  // An unknown order is A to Z, and the list of the host stays as it was
  assert.deepEqual(order('bogus'), order('az'));
  assert.deepEqual(titles(HOST_APPS), ['Desktop', 'Steam Big Picture', 'Cyberpunk 2077', 'Forza Horizon 5', 'alan wake 2', 'Game 10', 'Game 9']);
});

test('Recently played: the recently played apps first, the latest first, then the others from A to Z; matched by ID or title', () => {
  const menus = loadMenus();
  // Forza by its ID, Desktop by its title after its ID changed, and an app that the host no longer lists
  const recent = [{ id: '14', title: 'Forza Horizon 5' }, { id: '99', title: 'Gone' }, { id: '21', title: 'Desktop' }];
  assert.deepEqual(titles(menus.get('orderAppList')(HOST_APPS, 'recent', [], recent)),
    ['Forza Horizon 5', 'Desktop', 'alan wake 2', 'Cyberpunk 2077', 'Game 9', 'Game 10', 'Steam Big Picture']);
  // Nothing played yet: A to Z
  assert.deepEqual(titles(menus.get('orderAppList')(HOST_APPS, 'recent', [], [])), titles(menus.get('orderAppList')(HOST_APPS, 'az', [], [])));
});

test('the favorites come first in every order, matched by ID or title, each part in the order of the setting', () => {
  const menus = loadMenus();
  // Steam by its ID, Game 9 by its title after its ID changed
  const favorites = [{ id: '12', title: 'Steam Big Picture' }, { id: '42', title: 'Game 9' }];
  const recent = [{ id: '14', title: 'Forza Horizon 5' }, { id: '17', title: 'Game 9' }];
  const order = (sortOrder) => titles(menus.get('orderAppList')(HOST_APPS, sortOrder, favorites, recent));
  assert.deepEqual(order('az'), ['Game 9', 'Steam Big Picture', 'alan wake 2', 'Cyberpunk 2077', 'Desktop', 'Forza Horizon 5', 'Game 10']);
  assert.deepEqual(order('za'), ['Steam Big Picture', 'Game 9', 'Game 10', 'Forza Horizon 5', 'Desktop', 'Cyberpunk 2077', 'alan wake 2']);
  assert.deepEqual(order('recent'), ['Game 9', 'Steam Big Picture', 'Forza Horizon 5', 'alan wake 2', 'Cyberpunk 2077', 'Desktop', 'Game 10']);
  assert.deepEqual(order('host'), ['Steam Big Picture', 'Game 9', 'Desktop', 'Cyberpunk 2077', 'Forza Horizon 5', 'alan wake 2', 'Game 10']);
});

test('apps that are equal for an order keep the order of the host, also with a sort that mixes up equal elements', () => {
  const menus = loadMenus();
  // Chromium 69 sorts more than 10 elements with a quicksort that doesn't keep the order of equal elements: a sort
  // that reverses them stands in for it
  menus.run(`Array.prototype.sort = function(compare) {
    for (let i = 0; i < this.length; i++) {
      for (let j = 0; j < this.length - 1 - i; j++) {
        if (compare(this[j], this[j + 1]) >= 0) {
          const swap = this[j]; this[j] = this[j + 1]; this[j + 1] = swap;
        }
      }
    }
    return this;
  };`);
  const apps = [];
  for (let i = 0; i < 14; i++) {
    apps.push({ id: 100 + i, title: i % 2 ? 'Same' : 'Same ' + String.fromCharCode(65 + i) });
  }
  // Lists made in the context, whose arrays sort with the sort of the context
  const inContext = (value) => menus.run('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')');
  const order = (sortOrder, favorites) => plain(menus.get('orderAppList')(inContext(apps), sortOrder, inContext(favorites || []), inContext([])));
  const sameIds = (list) => list.filter((app) => app.title === 'Same').map((app) => app.id);
  // The stand-in really mixes up equal elements
  assert.notDeepEqual(plain(menus.run('[1, 2, 3].sort(() => 0)')), [1, 2, 3]);
  assert.deepEqual(sameIds(order('az')), [101, 103, 105, 107, 109, 111, 113]);
  assert.deepEqual(sameIds(order('za')), [101, 103, 105, 107, 109, 111, 113]);
  assert.deepEqual(order('host').map((app) => app.id), apps.map((app) => app.id));
  assert.deepEqual(order('host', [{ id: '113', title: '' }, { id: '100', title: '' }]).map((app) => app.id),
    [100, 113].concat(apps.map((app) => app.id).filter((id) => id !== 100 && id !== 113)));
});

test('the setting reads the switch of earlier versions: true is Z to A, false and anything unknown A to Z', () => {
  const menus = loadMenus();
  const parse = menus.get('parseAppSortOrder');
  assert.deepEqual(plain(menus.get('APP_SORT_ORDERS')), ['az', 'za', 'recent', 'host']);
  assert.deepEqual([true, false, null, undefined, 'az', 'za', 'recent', 'host', 'DESC', 1].map(parse),
    ['za', 'az', 'az', 'az', 'az', 'za', 'recent', 'host', 'az', 'az']);
});

test('the favorites are stored per host and matched by their title, also after a new ID, and a deleted host forgets them', () => {
  const menus = loadMenus();
  const set = menus.get('setAppFavorite');
  let favorites = plain(set([], { id: 12, title: 'Steam Big Picture' }, true));
  assert.deepEqual(favorites, [{ id: '12', title: 'Steam Big Picture' }]);
  favorites = plain(set(favorites, { id: 13, title: 'Cyberpunk 2077' }, true));
  // Adding an app again keeps one entry; removing it by its title after its ID changed removes it
  assert.deepEqual(plain(set(favorites, { id: 12, title: 'Steam Big Picture' }, true)).length, 2);
  assert.deepEqual(plain(set(favorites, { id: 77, title: 'Steam Big Picture' }, false)), [{ id: '13', title: 'Cyberpunk 2077' }]);

  menus.get('saveFavoriteApps')('HOST1', favorites);
  assert.deepEqual(JSON.parse(menus.context.localStorage.getItem('favoriteApps_HOST1')), favorites);
  assert.deepEqual(plain(menus.get('loadFavoriteApps')('HOST1')), favorites);
  assert.deepEqual(plain(menus.get('loadFavoriteApps')('HOST2')), [], 'another host keeps its own');
  assert.equal(menus.get('isAppListed')(favorites, { id: 99, title: 'Cyberpunk 2077' }), true);
  // A broken entry is ignored
  menus.context.localStorage.setItem('favoriteApps_HOST3', '{"not":"a list"}');
  assert.deepEqual(plain(menus.get('loadFavoriteApps')('HOST3')), []);

  menus.get('rememberRecentApp')('HOST1', { id: 13, title: 'Cyberpunk 2077' });
  menus.get('saveHiddenApps')('HOST1', [{ id: '11', title: 'Desktop' }]);
  menus.get('forgetHiddenApps')('HOST1');
  assert.deepEqual(['hiddenApps_HOST1', 'favoriteApps_HOST1', 'recentApps_HOST1'].map((key) => menus.context.localStorage.getItem(key)),
    [null, null, null]);
});

test('an entry with a title is the app with that title, so apps that a host numbered anew are never mixed up', () => {
  const menus = loadMenus();
  // Sunshine numbered its apps by their place: Steam was app 2 before Desktop (app 1) was deleted on the host
  const renumbered = [{ id: 1, title: 'Steam' }, { id: 2, title: 'Playnite' }];
  const favorites = [{ id: '2', title: 'Steam' }];
  assert.deepEqual(titles(menus.get('orderAppList')(renumbered, 'za', favorites, [])), ['Steam', 'Playnite']);
  assert.equal(menus.get('isAppListed')(favorites, renumbered[0], renumbered), true);
  assert.equal(menus.get('isAppListed')(favorites, renumbered[1], renumbered), false, 'the old ID of Steam is not Playnite');
  assert.equal(menus.get('isAppListed')(favorites, renumbered[1]), false, 'also without the list of the host');
  // Removing Playnite (which isn't a favorite) keeps Steam; removing Steam by its new ID removes it
  const set = menus.get('setAppFavorite');
  assert.deepEqual(plain(set(favorites, renumbered[1], false, renumbered)), favorites);
  assert.deepEqual(plain(set(favorites, renumbered[0], false, renumbered)), []);
  // Recently played: Steam ranks first, Playnite with the old ID of Steam doesn't
  const recent = [{ id: '2', title: 'Steam' }];
  assert.deepEqual(titles(menus.get('orderAppList')([{ id: 2, title: 'Playnite' }, { id: 1, title: 'Steam' }, { id: 3, title: 'Desktop' }], 'recent', [], recent)),
    ['Steam', 'Desktop', 'Playnite']);

  // Two apps of a host with the same title: the entry with the ID and the title of one is only that one
  const twins = [{ id: 2, title: 'Steam' }, { id: 5, title: 'Steam' }, { id: 7, title: 'Desktop' }];
  assert.deepEqual(twins.map((app) => menus.get('isAppListed')([{ id: '2', title: 'Steam' }], app, twins)), [true, false, false]);
  assert.deepEqual(plain(menus.get('orderAppList')(twins, 'host', [{ id: '5', title: 'Steam' }], [])).map((app) => app.id), [5, 2, 7]);
  assert.deepEqual(plain(set([{ id: '2', title: 'Steam' }, { id: '5', title: 'Steam' }], twins[1], false, twins)), [{ id: '2', title: 'Steam' }]);

  // An entry without a title (the app remembered as the last one opened) is the app with its ID only
  assert.equal(menus.get('isAppListed')([{ id: '2', title: '' }], { id: 2, title: 'Playnite' }), true);
  assert.equal(menus.get('isAppListed')([{ id: '2', title: '' }], { id: 3, title: '' }), false);
  // The hidden apps keep matching by ID or title, as before
  assert.equal(menus.get('isAppHidden')([{ id: '2', title: 'Steam' }], { id: 2, title: 'Playnite' }), true);
});

test('a started app goes to the front of the recently played apps of its host, once, and the list keeps the latest 20', () => {
  const menus = loadMenus();
  const remember = menus.get('rememberRecentApp');
  const load = (uid) => plain(menus.get('loadRecentApps')(uid));
  // An install that played before the list existed starts with the app it remembers as the last one opened
  menus.context.localStorage.setItem('lastOpenedApp_HOST1', '14');
  assert.deepEqual(load('HOST1'), [{ id: '14', title: '' }]);
  remember('HOST1', { id: 13, title: 'Cyberpunk 2077' });
  assert.deepEqual(load('HOST1'), [{ id: '13', title: 'Cyberpunk 2077' }, { id: '14', title: '' }]);
  // Played again with a new ID: one entry, at the front, with the new ID
  remember('HOST1', { id: 14, title: 'Forza Horizon 5' });
  remember('HOST1', { id: 31, title: 'Cyberpunk 2077' });
  assert.deepEqual(load('HOST1'), [{ id: '31', title: 'Cyberpunk 2077' }, { id: '14', title: 'Forza Horizon 5' }]);
  assert.deepEqual(load('HOST2'), [], 'another host keeps its own');

  // A host that numbered its apps anew: the new app with the old ID of Cyberpunk keeps Cyberpunk in the list
  remember('HOST1', { id: 31, title: 'Alan Wake 2' });
  assert.deepEqual(load('HOST1'), [{ id: '31', title: 'Alan Wake 2' }, { id: '31', title: 'Cyberpunk 2077' }, { id: '14', title: 'Forza Horizon 5' }]);

  for (let i = 0; i < 25; i++) {
    remember('HOST2', { id: 200 + i, title: 'Game ' + i });
  }
  const recent = load('HOST2');
  assert.equal(recent.length, 20);
  assert.deepEqual([recent[0].title, recent[19].title], ['Game 24', 'Game 5']);
});
