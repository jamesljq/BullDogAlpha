module.exports = {
  __esModule: true,
  createChart: () => ({
    addSeries: (typeClass) => ({
      setData: () => {},
      seriesType: () => typeClass === module.exports.LineSeries ? 'Line' : 'Candlestick',
    }),
    applyOptions: () => {},
    remove: () => {},
  }),
  LineSeries: {},
  CandlestickSeries: {},
  createSeriesMarkers: () => ({
    setMarkers: () => {},
  }),
};
