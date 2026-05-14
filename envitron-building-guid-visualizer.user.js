// ==UserScript==
// @name         Envitron gebouw GUID visualisatie
// @namespace    https://hoppenbrouwers.nl/
// @version      1.2.4
// @description  Maakt het gebouw GUID zichtbaar in het Envitron portaal en voegt filters toe
// @match        https://*.envitron.nl/*
// @match        https://*.envitron.energy/*
// @match        https://*.envitron.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const asciiArt = `
  _    _       _            _        _
 | |  | |     | |          / \\      | |
 | |__| |_   _| |_ ___    / _ \\     | | ___ _ __  ___
 |  __  | | | | __/ __|  / ___ \\ _  | |/ _ \\ '_ \\/ __|
 | |  | | |_| | |_\\__ \\ / /   \\ \\ || |  __/ | | \\__ \\
 |_|  |_|\\__,_|\\__|___//_/     \\_\\__/ \\___|_| |_|___/
  `;

  const logPrefix = '[GUID visualisatie]';
  const buildingsEndpointPath = '/web-api/buildings/';
  const buttonClass = 'tm-building-guid-button';
  const cardSelector = '[data-testid="building-card-select"], [data-testid="building-card-open"]';
  const buildingUuidRegex = /\/buildings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
  const filterControlId = 'tm-building-filter-control';

  const apiBuildingsByName = new Map();
  const domBuildingsByName = new Map();
  const loggedMissingNames = new Set();

  let observer;
  let renderTimerId = 0;
  let originalFetchRef = null;
  let hasTriedManualApiLoad = false;
  let currentFilter = 'all';

  const warn = (...args) => console.warn(logPrefix, ...args);

  console.log(
    `%c${asciiArt}`,
    'color: #2563eb; font-family: monospace; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,0,0.1);'
  );

  const injectFilterStyles = () => {
    if (document.getElementById('tm-filter-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'tm-filter-styles';

    style.textContent = `
      .tm-filter-wrapper {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        background: #f3f4f6;
        padding: 2px;
        border-radius: 8px;
        position: relative;
        user-select: none;
        width: fit-content;
        min-width: 260px;
        border: 1px solid #e5e7eb;
      }

      .tm-filter-bg {
        position: absolute;
        top: 2px;
        bottom: 2px;
        left: 0;
        width: var(--tm-filter-bg-width, calc((100% - 4px) / 3));
        background: white;
        border-radius: 6px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        transform: translateX(var(--tm-filter-bg-x, 2px));
        transition:
          transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
          width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 1;
        pointer-events: none;
      }

      .tm-filter-button {
        min-width: 0;
        margin: 0;
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 700;
        text-align: center;
        cursor: pointer;
        z-index: 2;
        transition: color 0.2s;
        color: #6b7280;
        border: none;
        background: transparent;
        outline: none;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
      }

      .tm-filter-button.active {
        color: #2563eb;
      }

      .tm-header-left-group {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
      }

      @media (max-width: 767px) {
        .tm-header-left-group {
          width: 100%;
        }

        .tm-filter-wrapper {
          width: 100%;
          min-width: 0;
        }
      }
    `;

    document.head.appendChild(style);
  };

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
        uuid,
        hasUnsolved: !!building.has_unsolved_notifications,
        unreadCount: parseInt(building.number_of_unread_messages || 0, 10)
      });
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

    xhrPrototype.open = function (method, url, ...args) {
      this.__guidVisualisatieUrl = url;
      return originalOpen.call(this, method, url, ...args);
    };

    xhrPrototype.send = function (body) {
      this.addEventListener('load', () => {
        if (!isBuildingsEndpoint(this.__guidVisualisatieUrl)) {
          return;
        }

        handleBuildingsPayload(this.response || this.responseText, 'XMLHttpRequest');
      });

      return originalSend.call(this, body);
    };

    Object.defineProperty(xhrPrototype, '__guidVisualisatiePatched', {
      value: true
    });
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

  const updateFilterHighlight = wrapper => {
    const activeButton = wrapper.querySelector('.tm-filter-button.active');

    if (!activeButton) {
      return;
    }

    wrapper.style.setProperty('--tm-filter-bg-x', `${activeButton.offsetLeft}px`);
    wrapper.style.setProperty('--tm-filter-bg-width', `${activeButton.offsetWidth}px`);
  };

  const scheduleFilterHighlightUpdate = wrapper => {
    window.requestAnimationFrame(() => {
      updateFilterHighlight(wrapper);
    });
  };

  const getCardSectionTitle = card => {
    const section = card.closest('section');
    const heading = section?.querySelector('h2');

    return heading?.textContent?.trim().toUpperCase() ?? '';
  };

  const isFilterableBuildingCard = card => {
    const sectionTitle = getCardSectionTitle(card);

    return sectionTitle.includes('GEBOUWEN') && sectionTitle !== 'GESELECTEERD';
  };

  const applyFilters = () => {
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach(card => {
      if (!isFilterableBuildingCard(card)) {
        card.style.display = '';
        return;
      }

      const name = normalizeName(getCardName(card));
      const building = apiBuildingsByName.get(name);

      let visible = true;

      if (currentFilter === 'notifications') {
        visible = !!building?.hasUnsolved;
      } else if (currentFilter === 'messages') {
        visible = (building?.unreadCount || 0) > 0;
      }

      card.style.display = visible ? '' : 'none';
    });
  };

  const updateExistingFilterControl = wrapper => {
    wrapper.dataset.active = currentFilter;

    wrapper
      .querySelectorAll('.tm-filter-button')
      .forEach(button => {
        button.classList.toggle('active', button.dataset.filterId === currentFilter);
      });

    scheduleFilterHighlightUpdate(wrapper);
  };

  const injectFilterControl = () => {
    const existingFilter = document.getElementById(filterControlId);

    if (existingFilter) {
      updateExistingFilterControl(existingFilter);
      return;
    }

    const headers = Array.from(document.querySelectorAll('h2'))
      .filter(header => {
        const title = header.textContent.trim().toUpperCase();

        return title.includes('GEBOUWEN') && title !== 'GESELECTEERD';
      });

    const h2 = headers[0];
    const container = h2?.parentElement;

    if (!container) {
      return;
    }

    injectFilterStyles();

    let leftGroup = container.querySelector('.tm-header-left-group');

    if (!leftGroup) {
      leftGroup = document.createElement('div');
      leftGroup.className = 'tm-header-left-group';

      h2.replaceWith(leftGroup);
      leftGroup.appendChild(h2);
    }

    const wrapper = document.createElement('div');
    wrapper.id = filterControlId;
    wrapper.className = 'tm-filter-wrapper';
    wrapper.dataset.active = currentFilter;

    const bg = document.createElement('div');
    bg.className = 'tm-filter-bg';
    wrapper.appendChild(bg);

    const options = [
      { id: 'all', label: 'Alle' },
      { id: 'notifications', label: 'Meldingen' },
      { id: 'messages', label: 'Berichten' }
    ];

    options.forEach(option => {
      const button = document.createElement('button');

      button.type = 'button';
      button.className = `tm-filter-button ${currentFilter === option.id ? 'active' : ''}`;
      button.textContent = option.label;
      button.dataset.filterId = option.id;

      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();

        currentFilter = option.id;
        wrapper.dataset.active = option.id;

        wrapper
          .querySelectorAll('.tm-filter-button')
          .forEach(filterButton => filterButton.classList.remove('active'));

        button.classList.add('active');

        scheduleFilterHighlightUpdate(wrapper);
        applyFilters();
      };

      wrapper.appendChild(button);
    });

    leftGroup.appendChild(wrapper);
    scheduleFilterHighlightUpdate(wrapper);

    if (window.ResizeObserver) {
      const resizeObserver = new ResizeObserver(() => {
        scheduleFilterHighlightUpdate(wrapper);
      });

      resizeObserver.observe(wrapper);
    } else {
      window.addEventListener('resize', () => {
        scheduleFilterHighlightUpdate(wrapper);
      });
    }
  };

  const renderGuidButtons = reason => {
    syncDomBuildingLinksIntoMap();
    injectFilterControl();

    const cards = document.querySelectorAll(cardSelector);

    let addedCount = 0;
    let missingCount = 0;

    for (const card of cards) {
      const buildingName = getCardName(card);

      if (!buildingName) {
        continue;
      }

      const { uuid } = getUuidForCard(card);

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
        if (existingButton.dataset.buildingUuid !== uuid) {
          existingButton.textContent = uuid;
          existingButton.title = `Klik om GUID te kopiëren: ${uuid}`;
          existingButton.dataset.buildingUuid = uuid;
        }

        continue;
      }

      const button = createGuidButton(buildingName, uuid);

      titleRow.appendChild(button);

      addedCount++;
    }

    applyFilters();

    const filter = document.getElementById(filterControlId);

    if (filter) {
      scheduleFilterHighlightUpdate(filter);
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