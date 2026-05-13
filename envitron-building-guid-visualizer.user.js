// ==UserScript==
// @name         Envitron gebouw GUID visualisatie
// @namespace    https://hoppenbrouwers.nl/
// @version      1.1.0
// @description  Maakt het gebouw GUID zichtbaar in het Envitron portaal
// @match        https://*.envitron.nl/*
// @match        https://*.envitron.energy/*
// @match        https://*.envitron.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const logPrefix = '[GUID visualisatie]';
  const buildingsEndpointPath = '/web-api/buildings/';
  const buttonClass = 'tm-building-guid-button';
  const cardSelector = '[data-testid="building-card-select"], [data-testid="building-card-open"]';
  const buildingUuidRegex = /\/buildings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

  const apiBuildingsByName = new Map();
  const domBuildingsByName = new Map();

  const loggedMissingNames = new Set();

  let observer;
  let renderTimerId = 0;
  let originalFetchRef = null;
  let hasTriedManualApiLoad = false;
  let lastDomIndexedCount = -1;
  let lastRenderSummary = '';

  const log = (...args) => console.log(logPrefix, ...args);
  const warn = (...args) => console.warn(logPrefix, ...args);

  log('Userscript loaded');

  const normalizeName = value =>
    String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

  const normalizeUuid = value => {
    const match = String(value ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match?.[0]?.toLowerCase() ?? null;
  };

  const extractUuidFromUrl = url => {
    try {
      const parsedUrl = new URL(url, window.location.origin);
      return normalizeUuid(parsedUrl.pathname.match(buildingUuidRegex)?.[1]);
    } catch {
      return normalizeUuid(String(url).match(buildingUuidRegex)?.[1]);
    }
  };

  const isBuildingsEndpoint = url => {
    try {
      const parsedUrl = new URL(url, window.location.origin);
      return parsedUrl.pathname.toLowerCase() === buildingsEndpointPath;
    } catch {
      return String(url ?? '').toLowerCase() === buildingsEndpointPath;
    }
  };

  const parsePayload = payload => {
    if (!payload) {
      return null;
    }

    if (typeof payload !== 'string') {
      return payload;
    }

    try {
      return JSON.parse(payload);
    } catch (error) {
      warn('Could not parse JSON payload.', error);
      return null;
    }
  };

  const looksLikeBuilding = value =>
    value &&
    typeof value === 'object' &&
    typeof value.name === 'string' &&
    normalizeUuid(value.uuid ?? value.id ?? value.guid);

  const findBuildingArray = value => {
    if (Array.isArray(value)) {
      return value.some(looksLikeBuilding)
        ? value
        : null;
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    const preferredKeys = ['buildings', 'data', 'items', 'results', 'value'];

    for (const key of preferredKeys) {
      const nestedValue = value[key];

      if (Array.isArray(nestedValue) && nestedValue.some(looksLikeBuilding)) {
        return nestedValue;
      }
    }

    for (const nestedValue of Object.values(value)) {
      if (Array.isArray(nestedValue) && nestedValue.some(looksLikeBuilding)) {
        return nestedValue;
      }
    }

    return null;
  };

  const getBuildingUuid = building =>
    normalizeUuid(building.uuid ?? building.id ?? building.guid ?? building.buildingUuid);

  const handleBuildingsPayload = (payload, source) => {
    log(`Buildings payload received from ${source}`);

    const json = parsePayload(payload);
    const buildings = findBuildingArray(json);

    if (!buildings) {
      warn('No building array found in payload.', json);
      return;
    }

    apiBuildingsByName.clear();

    for (const building of buildings) {
      const name = String(building.name ?? '').trim();
      const uuid = getBuildingUuid(building);

      if (!name || !uuid) {
        warn('Skipping building without name or UUID.', building);
        continue;
      }

      apiBuildingsByName.set(normalizeName(name), {
        name,
        uuid
      });
    }

    log(`Building GUID array loaded from ${source}. Count: ${apiBuildingsByName.size}`);

    console.table(
      [...apiBuildingsByName.values()].slice(0, 25).map(building => ({
        name: building.name,
        uuid: building.uuid
      }))
    );

    if (apiBuildingsByName.size > 25) {
      log(`Console table shows first 25 of ${apiBuildingsByName.size} buildings.`);
    }

    scheduleRender('API building GUIDs loaded');
  };

  const patchXmlHttpRequest = () => {
    const xhrPrototype = window.XMLHttpRequest?.prototype;

    if (!xhrPrototype || xhrPrototype.__guidVisualisatiePatched) {
      return;
    }

    const originalOpen = xhrPrototype.open;
    const originalSend = xhrPrototype.send;

    xhrPrototype.open = function(method, url, ...args) {
      this.__guidVisualisatieUrl = url;
      return originalOpen.call(this, method, url, ...args);
    };

    xhrPrototype.send = function(body) {
      this.addEventListener('load', () => {
        if (!isBuildingsEndpoint(this.__guidVisualisatieUrl)) {
          return;
        }

        log('Buildings endpoint intercepted via XMLHttpRequest:', this.__guidVisualisatieUrl);
        handleBuildingsPayload(this.response || this.responseText, 'XMLHttpRequest');
      });

      return originalSend.call(this, body);
    };

    Object.defineProperty(xhrPrototype, '__guidVisualisatiePatched', {
      value: true
    });

    log('XMLHttpRequest patched');
  };

  const patchFetch = () => {
    if (!window.fetch || window.fetch.__guidVisualisatiePatched) {
      return;
    }

    originalFetchRef = window.fetch;

    window.fetch = async (...args) => {
      const response = await originalFetchRef(...args);

      const requestUrl = typeof args[0] === 'string'
        ? args[0]
        : args[0]?.url;

      if (isBuildingsEndpoint(requestUrl)) {
        log('Buildings endpoint intercepted via fetch:', requestUrl);

        response
          .clone()
          .text()
          .then(payload => handleBuildingsPayload(payload, 'fetch'))
          .catch(error => warn('Could not read fetch response.', error));
      }

      return response;
    };

    Object.defineProperty(window.fetch, '__guidVisualisatiePatched', {
      value: true
    });

    log('fetch patched');
  };

  const tryLoadBuildingsFromApi = async () => {
    if (hasTriedManualApiLoad) {
      return;
    }

    hasTriedManualApiLoad = true;

    const fetchFn = originalFetchRef ?? window.fetch;

    if (!fetchFn) {
      warn('Manual API load skipped: fetch unavailable.');
      return;
    }

    try {
      log('Trying manual building GUID API load:', buildingsEndpointPath);

      const response = await fetchFn(buildingsEndpointPath, {
        credentials: 'same-origin'
      });

      if (!response.ok) {
        warn(`Manual API load failed. Status: ${response.status}`);
        return;
      }

      const payload = await response.text();
      handleBuildingsPayload(payload, 'manual API load');
    } catch (error) {
      warn('Manual API load failed.', error);
    }
  };

  const getCardNameElement = card =>
    card.querySelector('strong');

  const getCardName = card =>
    getCardNameElement(card)?.textContent?.trim() ?? '';

  const getCardTitleRow = card => {
    const nameElement = getCardNameElement(card);

    if (!nameElement) {
      return null;
    }

    return nameElement.closest('.flex.items-center.gap-2') ??
      nameElement.parentElement;
  };

  const getCardUuidFromLinks = card => {
    const preferredLink = card.querySelector('a[data-testid="building-card-open-link"][href]');
    const preferredUuid = extractUuidFromUrl(preferredLink?.getAttribute('href'));

    if (preferredUuid) {
      return preferredUuid;
    }

    const links = card.querySelectorAll('a[href*="/buildings/"]');

    for (const link of links) {
      const uuid = extractUuidFromUrl(link.getAttribute('href'));

      if (uuid) {
        return uuid;
      }
    }

    return null;
  };

  const getUuidForCard = card => {
    const directUuid = getCardUuidFromLinks(card);

    if (directUuid) {
      return {
        uuid: directUuid,
        source: 'card href'
      };
    }

    const name = getCardName(card);
    const normalizedName = normalizeName(name);

    const domMatch = domBuildingsByName.get(normalizedName);

    if (domMatch?.uuid) {
      return {
        uuid: domMatch.uuid,
        source: 'DOM name map'
      };
    }

    const apiMatch = apiBuildingsByName.get(normalizedName);

    if (apiMatch?.uuid) {
      return {
        uuid: apiMatch.uuid,
        source: 'API name map'
      };
    }

    return {
      uuid: null,
      source: null
    };
  };

  const syncDomBuildingLinksIntoMap = () => {
    const cards = document.querySelectorAll(cardSelector);
    let indexedCount = 0;

    for (const card of cards) {
      const name = getCardName(card);
      const uuid = getCardUuidFromLinks(card);

      if (!name || !uuid) {
        continue;
      }

      domBuildingsByName.set(normalizeName(name), {
        name,
        uuid
      });

      indexedCount++;
    }

    if (indexedCount !== lastDomIndexedCount) {
      lastDomIndexedCount = indexedCount;
      log(`DOM building links indexed. Count: ${indexedCount}`);
    }
  };

  const copyToClipboard = async value => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const textarea = document.createElement('textarea');

    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const copied = document.execCommand('copy');
    textarea.remove();

    if (!copied) {
      throw new Error('document.execCommand("copy") returned false.');
    }
  };

  const createGuidButton = (buildingName, buildingUuid) => {
    const button = document.createElement('button');

    button.type = 'button';
    button.className = buttonClass;
    button.textContent = buildingUuid;
    button.title = `Klik om GUID te kopiëren: ${buildingUuid}`;
    button.dataset.buildingUuid = buildingUuid;
    button.dataset.buildingName = buildingName;

    Object.assign(button.style, {
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: '100%',
      whiteSpace: 'nowrap',
      marginLeft: '8px',
      padding: '2px 6px',
      border: '1px solid #2563eb',
      borderRadius: '9999px',
      background: '#f7fbff',
      color: '#2563eb',
      fontSize: '11px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      lineHeight: '16px',
      cursor: 'copy'
    });

    const stopCardClick = event => {
      event.preventDefault();
      event.stopPropagation();
    };

    button.addEventListener('pointerdown', stopCardClick);
    button.addEventListener('mousedown', stopCardClick);

    button.addEventListener('click', async event => {
      stopCardClick(event);

      const originalText = button.textContent;

      try {
        await copyToClipboard(buildingUuid);

        log(`Copied UUID for "${buildingName}": ${buildingUuid}`);

        button.textContent = 'Copied!';

        setTimeout(() => {
          button.textContent = originalText;
        }, 1000);
      } catch (error) {
        warn(`Copy failed for "${buildingName}".`, error);
      }
    });

    return button;
  };

  const renderGuidButtons = reason => {
    syncDomBuildingLinksIntoMap();

    const cards = document.querySelectorAll(cardSelector);

    let addedCount = 0;
    let updatedCount = 0;
    let missingCount = 0;
    let duplicateCount = 0;

    for (const card of cards) {
      const buildingName = getCardName(card);

      if (!buildingName) {
        continue;
      }

      const { uuid, source } = getUuidForCard(card);

      if (!uuid) {
        missingCount++;

        const normalizedName = normalizeName(buildingName);

        if (!loggedMissingNames.has(normalizedName)) {
          loggedMissingNames.add(normalizedName);
          warn(`No UUID found yet for building: "${buildingName}"`);
        }

        continue;
      }

      const titleRow = getCardTitleRow(card);

      if (!titleRow) {
        warn(`No title row found for building: "${buildingName}"`);
        continue;
      }

      const existingButton = titleRow.querySelector(`.${buttonClass}`);

      if (existingButton) {
        duplicateCount++;

        if (existingButton.dataset.buildingUuid !== uuid) {
          existingButton.textContent = uuid;
          existingButton.title = `Klik om GUID te kopiëren: ${uuid}`;
          existingButton.dataset.buildingUuid = uuid;
          updatedCount++;
        }

        continue;
      }

      const button = createGuidButton(buildingName, uuid);

      titleRow.appendChild(button);

      addedCount++;
      log(`Added UUID button for "${buildingName}" from ${source}: ${uuid}`);
    }

    const summary = `Reason: ${reason}. Cards: ${cards.length}, added: ${addedCount}, updated: ${updatedCount}, missing: ${missingCount}, duplicates skipped: ${duplicateCount}`;

    if (summary !== lastRenderSummary) {
      lastRenderSummary = summary;
      log(`Render complete. ${summary}`);
    }

    if (missingCount > 0 && apiBuildingsByName.size === 0) {
      setTimeout(tryLoadBuildingsFromApi, 250);
    }
  };

  const scheduleRender = reason => {
    if (renderTimerId) {
      return;
    }

    renderTimerId = window.setTimeout(() => {
      renderTimerId = 0;
      renderGuidButtons(reason);
    }, 75);
  };

  const startObserver = () => {
    if (observer) {
      return;
    }

    const target = document.body ?? document.documentElement;

    if (!target) {
      return;
    }

    observer = new MutationObserver(() => {
      scheduleRender('DOM mutation');
    });

    observer.observe(target, {
      childList: true,
      subtree: true
    });

    log('DOM observer started');
  };

  const initDomHooks = () => {
    startObserver();
    scheduleRender('DOM ready');

    setTimeout(() => scheduleRender('delayed render 500ms'), 500);
    setTimeout(() => scheduleRender('delayed render 1500ms'), 1500);
    setTimeout(tryLoadBuildingsFromApi, 1500);
  };

  patchXmlHttpRequest();
  patchFetch();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDomHooks, {
      once: true
    });
  } else {
    initDomHooks();
  }
})();
