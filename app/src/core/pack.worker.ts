import { packImages, type PackItem, type PackOptions, type PackPos } from './pack'

interface PackWorkerRequest {
  id: number
  items: PackItem[]
  options: PackOptions
}

interface PackWorkerResponse {
  id: number
  entries: [string, PackPos][]
}

globalThis.addEventListener('message', (event: MessageEvent<PackWorkerRequest>) => {
  const positions = packImages(event.data.items, event.data.options)
  const response: PackWorkerResponse = {
    id: event.data.id,
    entries: Array.from(positions.entries()),
  }
  globalThis.postMessage(response)
})

