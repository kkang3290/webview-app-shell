import environment from './env/config'
__LIFECYCLE_IMPORT__

App({
  globalData: { environment },
  onLaunch(options: unknown) {
    __LIFECYCLE_LAUNCH__
  },
  onShow(options: unknown) {
    __LIFECYCLE_SHOW__
  },
})
