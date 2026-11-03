import {
  CesiumWidget, EllipsoidTerrainProvider, UrlTemplateImageryProvider, WebMercatorTilingScheme,
  Cartesian3, Cartesian2, Color, ScreenSpaceEventType, Math as CesiumMath, CustomDataSource,
  DataSourceCollection, DataSourceDisplay, JulianDate, Rectangle, PolygonHierarchy, SplitDirection,
} from 'cesium';

globalThis.CESIUM_BASE_URL = '/vendor/cesium/';
globalThis.Cesium = {
  CesiumWidget, EllipsoidTerrainProvider, UrlTemplateImageryProvider, WebMercatorTilingScheme,
  Cartesian3, Cartesian2, Color, ScreenSpaceEventType, Math: CesiumMath, CustomDataSource,
  DataSourceCollection, DataSourceDisplay, JulianDate, Rectangle, PolygonHierarchy, SplitDirection,
};
