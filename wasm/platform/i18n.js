(function(global) {
  'use strict';

  const LANGUAGE_SETTING_KEY = 'languagePreference';
  const SOURCE_LOCALE = 'en-US';
  // The languages of the app, in the order of the language menu after Auto. Each one is named in its own language, so
  // that it can be found whatever language the app shows. Every language costs about 60 KB in the package, so the
  // list stays short (docs/TRANSLATING.md). A locale file in static/locales needs its entry here, and the other way
  // round (tests/tools/i18n-check.js).
  const LOCALES = [
    { code: 'en-US', name: 'English' },
    { code: 'de-DE', name: 'Deutsch' },
    { code: 'es-ES', name: 'Español' },
    { code: 'fr-FR', name: 'Français' },
    { code: 'pt-BR', name: 'Português (Brasil)' },
  ];
  const SUPPORTED_LOCALES = LOCALES.map((locale) => locale.code);

  const state = {
    localePreference: 'auto',
    effectiveLocale: SOURCE_LOCALE,
    dictionary: {},
    sourceDictionary: {},
    initialized: false,
    refreshCallbacks: [],
  };

  function formatPositional(template, values) {
    if (!template || !values || !values.length) {
      return template;
    }

    return template.replace(/%(\d+)\$[sd]/g, (match, index) => {
      const value = values[Number(index) - 1];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  function t(key, ...values) {
    const translated = state.dictionary[key];
    const source = state.sourceDictionary[key];
    const result = translated || source || key;
    return formatPositional(result, values);
  }

  function _n(singular, plural, count) {
    return count === 1 ? t(singular, count) : t(plural, count);
  }

  // The supported locale for a language tag of the TV or the browser, e.g. 'de_AT' or 'pt-PT': the locale itself, else
  // the locale of the same language (de-AT and de-CH get de-DE, pt-PT gets pt-BR), else '' for a language the app
  // doesn't have
  function matchLocale(rawLocale) {
    if (!rawLocale || typeof rawLocale !== 'string') {
      return '';
    }

    const locale = rawLocale.trim().replace(/_/g, '-').toLowerCase();
    const exact = SUPPORTED_LOCALES.find((supportedLocale) => supportedLocale.toLowerCase() === locale);
    if (exact) {
      return exact;
    }

    const langPrefix = locale.split('-')[0];
    return SUPPORTED_LOCALES.find((supportedLocale) => supportedLocale.split('-')[0].toLowerCase() === langPrefix) || '';
  }

  // The locale that the app shows for a language of the TV: a supported one, or English for any other language
  function normalizeDetectedLocale(rawLocale) {
    return matchLocale(rawLocale) || SOURCE_LOCALE;
  }

  // The first language of the browser that the app has (on a TV the browser has the language of the TV)
  function detectLocaleFromNavigator() {
    const browserLocales = Array.isArray(navigator.languages) ? navigator.languages : [];
    const candidates = browserLocales.concat([navigator.language]);
    for (let i = 0; i < candidates.length; i++) {
      const match = matchLocale(candidates[i]);
      if (match) {
        return match;
      }
    }
    return SOURCE_LOCALE;
  }

  function detectLocale() {
    return new Promise((resolve) => {
      if (typeof tizen === 'undefined' || !tizen.systeminfo || typeof tizen.systeminfo.getPropertyValue !== 'function') {
        resolve(detectLocaleFromNavigator());
        return;
      }

      try {
        tizen.systeminfo.getPropertyValue('LOCALE', (localeInfo) => {
          const languageRaw = localeInfo && localeInfo.language ? String(localeInfo.language).trim() : '';
          const countryRaw = localeInfo && localeInfo.country ? String(localeInfo.country).trim() : '';
          const language = languageRaw ? languageRaw.toLowerCase() : '';
          const country = countryRaw ? countryRaw.toUpperCase() : '';
          let locale = '';

          if (language && /[-_]/.test(language)) {
            locale = language;
          } else if (language && country) {
            locale = `${language}-${country}`;
          } else {
            locale = language || country || '';
          }

          resolve(normalizeDetectedLocale(locale));
        }, () => {
          resolve(detectLocaleFromNavigator());
        });
      } catch (error) {
        resolve(detectLocaleFromNavigator());
      }
    });
  }

  function readStoredPreference() {
    return new Promise((resolve) => {
      if (typeof window.getData === 'function') {
        try {
          window.getData(LANGUAGE_SETTING_KEY, (savedValue) => {
            const storedPreference = savedValue && typeof savedValue[LANGUAGE_SETTING_KEY] === 'string'
              ? savedValue[LANGUAGE_SETTING_KEY]
              : '';
            resolve(storedPreference);
          });
          return;
        } catch (error) {
          console.warn('[i18n.js] Failed to read language preference from settings store:', error);
        }
      }
      resolve('');
    });
  }

  function writeStoredPreference(preference) {
    const value = preference || 'auto';
    if (typeof window.storeData === 'function') {
      try {
        window.storeData(LANGUAGE_SETTING_KEY, value, null);
      } catch (error) {
        console.warn('[i18n.js] Failed to persist language preference in settings store:', error);
      }
    }
  }

  function loadLocaleFile(locale) {
    return fetch(`static/locales/${locale}.json`, { cache: 'no-store' }).then((response) => {
      if (!response.ok) {
        throw new Error(`Locale file not found: ${locale}`);
      }
      return response.json();
    });
  }

  function updateDocumentLanguage(locale) {
    document.documentElement.setAttribute('lang', locale || SOURCE_LOCALE);
  }

  // The entry of the language menu for a preference: Auto in the language of the app, a language by its own name
  function findLocale(code) {
    return LOCALES.find((locale) => locale.code === code) || null;
  }

  function showLanguageLabel(element, value) {
    const locale = findLocale(value);
    element.textContent = locale ? locale.name : t('Auto');
    if (locale) {
      element.setAttribute('lang', locale.code);
    } else {
      element.removeAttribute('lang');
    }
  }

  function updateLocalizedSelections() {
    const selectLanguage = document.getElementById('selectLanguage');
    if (selectLanguage) {
      showLanguageLabel(selectLanguage, selectLanguage.getAttribute('data-value') || state.localePreference || 'auto');
    }

    const selectResolution = document.getElementById('selectResolution');
    if (selectResolution) {
      const selectedItem = document.querySelector(`.videoResolutionMenu li[data-value="${selectResolution.dataset.value}"]`);
      if (selectedItem) {
        selectResolution.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }

    const selectFramerate = document.getElementById('selectFramerate');
    if (selectFramerate) {
      const selectedItem = document.querySelector(`.videoFramerateMenu li[data-value="${selectFramerate.dataset.value}"]`);
      if (selectedItem) {
        selectFramerate.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }

    const selectControllerType = document.getElementById('selectControllerType');
    if (selectControllerType) {
      const selectedItem = document.querySelector(`.controllerTypeMenu li[data-value="${selectControllerType.dataset.value}"]`);
      if (selectedItem) {
        selectControllerType.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }

    const selectAudioBackend = document.getElementById('selectAudioBackend');
    if (selectAudioBackend) {
      const selectedItem = document.querySelector(`.audioBackendMenu li[data-value="${selectAudioBackend.dataset.value}"]`);
      if (selectedItem) {
        selectAudioBackend.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }

    const selectAudio = document.getElementById('selectAudio');
    if (selectAudio) {
      const selectedItem = document.querySelector(`.audioConfigMenu li[data-value="${selectAudio.dataset.value}"]`);
      if (selectedItem) {
        selectAudio.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }

    const selectCodec = document.getElementById('selectCodec');
    if (selectCodec) {
      const selectedItem = document.querySelector(`.videoCodecMenu li[data-value="${selectCodec.dataset.value}"]`);
      if (selectedItem) {
        selectCodec.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }

    const selectPerformanceStats = document.getElementById('selectPerformanceStats');
    if (selectPerformanceStats) {
      const selectedItem = document.querySelector(`.performanceStatsMenu li[data-value="${selectPerformanceStats.dataset.value}"]`);
      if (selectedItem) {
        selectPerformanceStats.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }

    const selectStatsPosition = document.getElementById('selectStatsPosition');
    if (selectStatsPosition) {
      const selectedItem = document.querySelector(`.statsPositionMenu li[data-value="${selectStatsPosition.dataset.value}"]`);
      if (selectedItem) {
        selectStatsPosition.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }

    const selectSortAppsList = document.getElementById('selectSortAppsList');
    if (selectSortAppsList) {
      const selectedItem = document.querySelector(`.sortAppsListMenu li[data-value="${selectSortAppsList.dataset.value}"]`);
      if (selectedItem) {
        selectSortAppsList.textContent = t(selectedItem.getAttribute('data-i18n') || selectedItem.textContent.trim());
      }
    }
  }

  function refreshUI() {
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const key = element.getAttribute('data-i18n');
      const param = element.getAttribute('data-param');
      if (!key) {
        return;
      }
      element.textContent = param ? t(key, param) : t(key);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      const key = element.getAttribute('data-i18n-placeholder');
      if (!key) {
        return;
      }
      element.setAttribute('placeholder', t(key));
    });

    updateLocalizedSelections();
    state.refreshCallbacks.forEach((cb) => cb());
  }

  // Fill the language menu: Auto (the language of the TV), then each language by its own name
  function populateLanguageMenu(onSelect) {
    const menu = document.querySelector('ul.languageMenu');
    const button = document.getElementById('selectLanguage');
    if (!menu) return;

    while (menu.firstChild) {
      menu.removeChild(menu.firstChild);
    }
    ['auto'].concat(SUPPORTED_LOCALES).forEach((value) => {
      const li = document.createElement('li');
      li.className = 'mdl-menu__item';
      li.setAttribute('data-value', value);
      showLanguageLabel(li, value);
      if (value === 'auto') {
        // The translation pass of refreshUI() translates Auto again after a change of the language
        li.setAttribute('data-i18n', 'Auto');
      }
      if (typeof onSelect === 'function') {
        li.addEventListener('click', onSelect);
      }
      menu.appendChild(li);
    });

    // Set the button text to match the current data-value
    if (button) {
      showLanguageLabel(button, button.getAttribute('data-value') || 'auto');
    }
  }

  function applyLanguagePreference(preference) {
    state.localePreference = preference || 'auto';
    writeStoredPreference(state.localePreference);
    return setLanguage(state.localePreference);
  }

  function setLanguage(preference) {
    const requestedPreference = preference || state.localePreference || 'auto';
    // A language that the app doesn't have (any more) follows the TV like Auto
    const selectedPreference = SUPPORTED_LOCALES.includes(requestedPreference) ? requestedPreference : 'auto';
    const selectLanguage = document.getElementById('selectLanguage');
    if (selectLanguage) {
      selectLanguage.setAttribute('data-value', selectedPreference);
    }

    const resolveLocalePromise = selectedPreference === 'auto'
      ? detectLocale()
      : Promise.resolve(selectedPreference);

    return resolveLocalePromise.then((effectiveLocale) => loadLocaleFile(effectiveLocale).then((dict) => {
      state.effectiveLocale = effectiveLocale;
      state.dictionary = dict || {};
      updateDocumentLanguage(effectiveLocale);
      refreshUI();
      return effectiveLocale;
    })).catch((error) => {
      console.warn('[i18n.js] Failed to load locale. Falling back to source locale.', error);
      state.effectiveLocale = SOURCE_LOCALE;
      state.dictionary = state.sourceDictionary;
      updateDocumentLanguage(SOURCE_LOCALE);
      refreshUI();
      return SOURCE_LOCALE;
    });
  }

  function init() {
    if (state.initialized) {
      return Promise.resolve(state.effectiveLocale);
    }

    return readStoredPreference().then((storedPreference) => {
      const preference = storedPreference || 'auto';
      state.localePreference = preference;
      return loadLocaleFile(SOURCE_LOCALE)
        .then((sourceDict) => {
          state.sourceDictionary = sourceDict || {};
        })
        .catch(() => {
          state.sourceDictionary = {};
        })
        .then(() => setLanguage(preference))
        .then((effectiveLocale) => {
          state.initialized = true;
          return effectiveLocale;
        });
    });
  }

  global.i18n = {
    init,
    t,
    _n,
    refreshUI,
    setLanguage,
    applyLanguagePreference,
    populateLanguageMenu,
    getPreference: () => state.localePreference,
    getLocale: () => state.effectiveLocale,
    getSupportedLocales: () => SUPPORTED_LOCALES.slice(),
    getLocaleNames: () => LOCALES.map((locale) => ({ code: locale.code, name: locale.name })),
    resolveLocale: normalizeDetectedLocale,
    detectLocale,
    onRefresh: (cb) => { state.refreshCallbacks.push(cb); },
  };

  global.t = t;
  global._n = _n;
  global.refreshUI = refreshUI;
})(window);
