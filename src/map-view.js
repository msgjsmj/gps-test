// Leaflet rendering only. Everything is drawn from local-meter data through
// the current placement, so swapping the base map never touches the data.

import { centroid, toGeo, toLocal } from './geo.js';

const L = window.L;

// Base map is one swappable layer (later: a saved area map overlay).
const BASE_TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  options: { maxNativeZoom: 19, maxZoom: 21, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
};

export const STYLE = { // also paints the legend in the help dialog
  boundary: { color: '#8a5a2b', weight: 2, dashArray: '6 6', fill: false, interactive: false },
  locked: { color: '#718096', weight: 1.5, dashArray: '4 4', fillColor: '#a0aec0', fillOpacity: 0.5, interactive: false },
  area: { color: '#2f855a', weight: 2, fillColor: '#68d391', fillOpacity: 0.4, interactive: false },
  visited: { color: '#276749', weight: 2, fillColor: '#38a169', fillOpacity: 0.55 },
  building: { color: '#c05621', weight: 2, fillColor: '#ed8936', fillOpacity: 0.25 }, // a building in no area
  current: { color: '#d69e2e', weight: 4 },
  accuracy: { color: '#3182ce', weight: 1, fillOpacity: 0.12, interactive: false },
  dot: { radius: 7, color: '#fff', weight: 2, fillColor: '#3182ce', fillOpacity: 1, interactive: false },
  heading: { color: '#3182ce', weight: 0, fillOpacity: 0.35, interactive: false },
};

const LABEL = { permanent: true, direction: 'center', className: 'bldg-label' };

// Restarts the CSS "opening" animation on an outline.
function pulse(shape) {
  const el = shape.getElement();
  if (!el) return;
  el.classList.remove('unlock-pulse');
  void el.getBoundingClientRect(); // reflow so the animation runs again
  el.classList.add('unlock-pulse');
  el.addEventListener('animationend', () => el.classList.remove('unlock-pulse'), { once: true });
}

const LocateControl = L.Control.extend({
  onAdd() {
    const b = L.DomUtil.create('button', 'locate-btn');
    b.type = 'button';
    b.textContent = '◎';
    b.title = '내 위치로';
    b.setAttribute('aria-label', '내 위치로');
    L.DomEvent.disableClickPropagation(b);
    L.DomEvent.on(b, 'click', () => this.options.onLocate());
    return b;
  },
});

export function createMapView(el, { onMapClick, onBuildingClick, onAreaClick, onLocate }) {
  const map = L.map(el, { zoomControl: false, attributionControl: true });
  L.tileLayer(BASE_TILES.url, BASE_TILES.options).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  new LocateControl({ position: 'topright', onLocate }).addTo(map);
  // The map row resizes with the bottom sheet, not only with the window.
  new ResizeObserver(() => map.invalidateSize()).observe(el);

  const zoneLayer = L.layerGroup().addTo(map); // under the buildings
  const areaLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  const me = {
    accuracy: L.circle([0, 0], { ...STYLE.accuracy, radius: 1 }),
    wedge: L.polygon([[0, 0]], STYLE.heading),
    dot: L.circleMarker([0, 0], STYLE.dot),
  };
  let placement = null, buildingShapes = new Map(), areaShapes = new Map(), boundaryShape = null, lastAnimateKey = null;

  const ll = (p) => {
    const g = toGeo(placement, p);
    return [g.lat, g.lng];
  };
  const local = (latlng) => toLocal(placement, { lat: latlng.lat, lng: latlng.lng });

  map.on('click', (e) => onMapClick?.(local(e.latlng)));

  return {
    map,

    // Redraw everything for a placement (also used when it moves). An area is drawn as its
    // buildings' viewing zones and footprints, with a "?" over it while it is still closed.
    setArea(area, buildings, nextPlacement, areas) {
      placement = nextPlacement;
      zoneLayer.clearLayers();
      areaLayer.clearLayers();
      buildingShapes = new Map();
      areaShapes = new Map();
      boundaryShape = L.polygon(area.boundary.map(ll), STYLE.boundary).addTo(areaLayer);
      for (const b of buildings) {
        const shape = L.polygon(b.footprint.map(ll), STYLE.building)
          .bindTooltip(b.label ?? b.name, LABEL)
          .on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            onBuildingClick?.(b.id, local(e.latlng));
          })
          .addTo(areaLayer);
        shape.label = b.label ?? b.name;
        buildingShapes.set(b.id, shape);
      }
      for (const a of areas) {
        const members = buildings.filter((b) => a.buildingIds.includes(b.id));
        const zones = members.flatMap((b) => b.zones.map((z) => L.polygon(z.map(ll), STYLE.locked).addTo(zoneLayer)));
        const centers = members.map((b) => centroid(b.footprint));
        const center = [centers.reduce((s, c) => s + c[0], 0) / centers.length, centers.reduce((s, c) => s + c[1], 0) / centers.length];
        const marker = L.marker(ll(center), { icon: L.divIcon({ className: 'area-q', html: '?', iconSize: [30, 30] }), keyboard: false })
          .on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            onAreaClick?.(a.key, local(e.latlng));
          });
        areaShapes.set(a.key, { zones, footprints: members.map((b) => buildingShapes.get(b.id)), marker });
      }
    },

    // top: pixels covered by something over the map (the placement bar).
    fit({ top = 0 } = {}) {
      if (boundaryShape) map.fitBounds(boundaryShape.getBounds(), { paddingTopLeft: [16, 16 + top], paddingBottomRight: [16, 16] });
    },

    panTo(point, zoom) {
      map.setView(ll(point), zoom ?? Math.max(map.getZoom(), 18));
    },

    // Restyles only areas whose state changed (this runs several times a second). A closed area is
    // grey with a "?" and no building names; an open one shows its colour and names. current: the
    // area the visitor stands in. animateKey: an area that opens pulses only when this equals the
    // previous render's (same test, not a bulk load); null never animates.
    render({ opened, current, animateKey = null }) {
      const animate = animateKey !== null && animateKey === lastAnimateKey;
      lastAnimateKey = animateKey;
      for (const [key, s] of areaShapes) {
        const open = opened.has(key);
        const opening = animate && s.wasOpen === false && open;
        s.wasOpen = open;
        const styleKey = `${open}|${key === current}`;
        if (s.styleKey !== styleKey) {
          s.styleKey = styleKey;
          for (const z of s.zones) z.setStyle({ dashArray: null, ...(open ? STYLE.area : STYLE.locked), ...(key === current ? STYLE.current : {}) });
          for (const f of s.footprints) {
            f.setStyle({ dashArray: null, ...(open ? STYLE.visited : STYLE.locked) });
            // Bound or not (rather than closed): the first render can run before Leaflet has added the
            // shapes, and adding opens a permanent tooltip again.
            if (open && !f.getTooltip()) f.bindTooltip(f.label, LABEL);
            if (!open) f.unbindTooltip();
          }
          if (open) s.marker.remove();
          else if (!areaLayer.hasLayer(s.marker)) s.marker.addTo(areaLayer);
        }
        if (opening) [...s.zones, ...s.footprints].forEach(pulse);
      }
    },

    // point in local meters; heading as a local bearing or null. Layers are
    // created once and moved in place.
    setPosition(fix) {
      if (!fix) return meLayer.clearLayers();
      const center = ll(fix.point);
      if (!meLayer.hasLayer(me.dot)) {
        me.accuracy.addTo(meLayer);
        me.dot.addTo(meLayer);
      }
      me.accuracy.setLatLng(center).setRadius(fix.accuracy);
      me.dot.setLatLng(center);
      if (fix.heading === null || fix.heading === undefined) {
        meLayer.removeLayer(me.wedge); // not wedge.remove(): the group would still claim it and never re-add it
        return;
      }
      me.wedge.setLatLngs([
        center,
        ...[-18, -6, 6, 18].map((d) => {
          const a = ((fix.heading + d) * Math.PI) / 180;
          return ll([fix.point[0] + 30 * Math.sin(a), fix.point[1] + 30 * Math.cos(a)]);
        }),
      ]);
      if (!meLayer.hasLayer(me.wedge)) {
        me.wedge.addTo(meLayer);
        me.dot.bringToFront();
      }
    },
  };
}
