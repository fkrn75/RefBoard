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

let requestId = 0

export async function packImagesOffThread(items: PackItem[], options: PackOptions): Promise<Map<string, PackPos>> {
  if (items.length < 80 || typeof Worker !== 'function') {
    return packImages(items, options)
  }

  try {
    const worker = new Worker(new URL('./pack.worker.ts', import.meta.url), { type: 'module' })
    const id = requestId + 1
    requestId = id
    const response = await new Promise<PackWorkerResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<PackWorkerResponse>) => {
        if (event.data.id === id) resolve(event.data)
      }
      worker.onerror = () => reject(new Error('패킹 Worker 실행 실패'))
      const request: PackWorkerRequest = { id, items, options }
      worker.postMessage(request)
    })
    worker.terminate()
    return new Map(response.entries)
  } catch {
    return packImages(items, options)
  }
}

