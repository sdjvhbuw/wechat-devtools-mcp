Page({
  data: {
    name: '',
    tapCount: 0,
    switchOn: false,
    slider: 30,
    items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  },

  onInput(event) {
    this.setData({ name: event.detail.value });
  },

  onTap() {
    this.setData({ tapCount: this.data.tapCount + 1 });
  },

  onSwitch(event) {
    this.setData({ switchOn: event.detail.value });
  },

  onSlide(event) {
    this.setData({ slider: event.detail.value });
  },

  goDetail() {
    wx.navigateTo({ url: '/pages/detail/detail?from=index' });
  },

  addBy(value) {
    const next = this.data.tapCount + Number(value || 0);
    this.setData({ tapCount: next });
    return next;
  },
});
