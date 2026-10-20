// Leaflet rendering only. Everything is drawn from local-meter data through
// the current placement, so swapping the base map never touches the data.

import { toGeo, toLocal } from './geo.js';

const L = window.L;

// Base map is one swappable layer (later: a saved area map overlay).
const BASE_TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  options: { maxNativeZoom: 19, maxZoom: 21, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
};

export const STYLE = { // also paints the legend in the help dialog
  boundary: { color: '#8a5a2b', weight: 2, dashArray: '6 6', fill: false, interactive: false },
  zone: { color: '#2b6cb0', weight: 1, dashArray: '4 4', fillColor: '#4299e1', fillOpacity: 0.12, interactive: false },
  building: { color: '#c05621', weight: 2, fillColor: '#ed8936', fillOpacity: 0.25 },
  visited: { color: '#276749', weight: 2, fillColor: '#38a169', fillOpacity: 0.55 },
  candidate: { color: '#d69e2e', weight: 5 },
  accuracy: { color: '#3182ce', weight: 1, fillOpacity: 0.12, interactive: false },
  dot: { radius: 7, color: '#fff', weight: 2, fillColor: '#3182ce', fillOpacity: 1, interactive: false },
  heading: { color: '#3182ce', weight: 0, fillOpacity: 0.35, interactive: false },
};

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

export function createMapView(el, { onMapClick, onBuildingClick, onLocate }) {
  const map = L.map(el, { zoomControl: false, attributionControl: true });
  L.tileLayer(BASE_TILES.url, BASE_TILES.options).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  new LocateControl({ position: 'topright', onLocate }).addTo(map);
  // The map row resizes with the bottom sheet, not only with the window.
  new ResizeObserver(() => map.invalidateSize()).observe(el);

  const areaLayer = L.layerGroup().addTo(map);
  const zoneLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  const me = {
    accuracy: L.circle([0, 0], { ...STYLE.accuracy, radius: 1 }),
    wedge: L.polygon([[0, 0]], STYLE.heading),
    dot: L.circleMarker([0, 0], STYLE.dot),
  };
  let placement = null, buildingShapes = new Map(), boundaryShape = null;

  const ll = (p) => {
    const g = toGeo(placement, p);
    return [g.lat, g.lng];
  };

  map.on('click', (e) => onMapClick?.(toLocal(placement, { lat: e.latlng.lat, lng: e.latlng.lng })));

  return {
    map,

    // Redraw the whole area for a placement (also used when it moves).
    setArea(area, buildings, nextPlacement) {
      placement = nextPlacement;
      areaLayer.clearLayers();
      zoneLayer.clearLayers();
      buildingShapes = new Map();
      boundaryShape = L.polygon(area.boundary.map(ll), STYLE.boundary).addTo(areaLayer);
      for (const b of buildings) {
        for (const z of b.zones) L.polygon(z.map(ll), STYLE.zone).addTo(zoneLayer);
        const shape = L.polygon(b.footprint.map(ll), STYLE.building)
          .bindTooltip(b.name, { permanent: true, direction: 'center', className: 'bldg-label' })
          .on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            onBuildingClick?.(b.id, toLocal(placement, { lat: e.latlng.lat, lng: e.latlng.lng }));
          })
          .addTo(areaLayer);
        buildingShapes.set(b.id, shape);
      }
    },

    // top: pixels covered by something over the map (the placement bar).
    fit({ top = 0 } = {}) {
      if (boundaryShape) map.fitBounds(boundaryShape.getBounds(), { paddingTopLeft: [16, 16 + top], paddingBottomRight: [16, 16] });
    },

    panTo(point, zoom) {
      map.setView(ll(point), zoom ?? Math.max(map.getZoom(), 18));
    },

    focus(id) {
      const shape = buildingShapes.get(id);
      if (shape) map.fitBounds(shape.getBounds(), { maxZoom: 19, padding: [80, 80] });
    },

    // Restyles only buildings whose state changed (this runs several times a second).
    render({ visited, candidateId, showZones }) {
      for (const [id, shape] of buildingShapes) {
        const key = `${visited.has(id)}|${id === candidateId}`;
        if (shape.styleKey === key) continue;
        shape.styleKey = key;
        shape.setStyle({ ...(visited.has(id) ? STYLE.visited : STYLE.building), ...(id === candidateId ? STYLE.candidate : {}) });
      }
      if (showZones && !map.hasLayer(zoneLayer)) zoneLayer.addTo(map);
      if (!showZones && map.hasLayer(zoneLayer)) zoneLayer.remove();
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
