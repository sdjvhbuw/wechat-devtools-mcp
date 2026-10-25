Page({
  data: {
    from: '',
  },

  onLoad(query) {
    this.setData({ from: query.from || '' });
  },
});
