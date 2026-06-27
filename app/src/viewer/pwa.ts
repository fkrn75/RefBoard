export async function registerServiceWorker(swUrl: string = '/sw.js'): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const hadController = navigator.serviceWorker.controller !== null
  try {
    const reg = await navigator.serviceWorker.register(swUrl, { scope: '/', updateViaCache: 'none' })
    let reloaded = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || !hadController) return
      reloaded = true
      window.location.reload()
    })
    void reg.update()
  } catch (err) {
    console.warn('[pwa] 서비스워커 등록 실패:', err)
  }
}
