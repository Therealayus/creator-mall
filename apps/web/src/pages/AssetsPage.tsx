import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { assetUrl, deleteAsset, fetchAssets, uploadAsset } from '../lib/api.js'
import type { AssetKind, AssetSummary } from '../lib/api.js'
import { assetHeadline, fileSize, isPreviewable } from '../lib/view-models.js'

/**
 * The creator's own library: what we made for them, and what they brought.
 *
 * Nothing here knows how an artifact was produced beyond what the server
 * already labelled, so the page cannot claim something was written by a model
 * when it was rendered here.
 */
export function AssetsPage(): ReactNode {
  const [assets, setAssets] = useState<AssetSummary[]>([])
  const [filter, setFilter] = useState<AssetKind | ''>('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function load(): Promise<void> {
    try {
      const result = await fetchAssets(filter === '' ? undefined : filter)
      setAssets(result.assets)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load your library just now')
    } finally {
      // Without this the first paint says "Nothing here yet" while the request
      // is still in flight, and an empty library looks like a slow one.
      setLoading(false)
    }
  }

  useEffect(() => {
    // Re-runs when the filter changes, which is the only thing it depends on.
    void load()
  }, [filter])

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      await uploadAsset(file, file.name.replace(/\.[^.]+$/, ''))
      setNotice(`Added ${file.name}.`)
      setError(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add that file just now')
    } finally {
      setBusy(false)
      // Clear the input so choosing the same file again still fires a change.
      event.target.value = ''
    }
  }

  async function onDelete(asset: AssetSummary): Promise<void> {
    setBusy(true)
    try {
      await deleteAsset(asset.id)
      setNotice(`Removed ${asset.title}.`)
      setError(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove that just now')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Your library</h1>
        <p>
          Everything we have made for you, and everything you have added. Files stay on this machine
          until you delete them.
        </p>
      </div>

      {error && <div className="notice stop">{error}</div>}
      {notice && <div className="notice good">{notice}</div>}

      <div className="row" style={{ margin: '18px 0' }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="asset-filter">Show</label>
          <select
            id="asset-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as AssetKind | '')}
          >
            <option value="">Everything</option>
            <option value="IMAGE">Posters</option>
            <option value="STORYBOARD">Shot lists</option>
            <option value="VIDEO">Videos</option>
            <option value="AUDIO">Audio</option>
            <option value="TEXT">Text</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="asset-upload">Add a file</label>
          <input id="asset-upload" type="file" disabled={busy} onChange={(event) => void onUpload(event)} />
        </div>
      </div>

      {loading ? (
        <p className="empty">Loading your library…</p>
      ) : assets.length === 0 && !error ? (
        <p className="empty">
          Nothing here yet. Generate something from Create, or add a file you already have.
        </p>
      ) : (
        <div className="grid cols-2">
          {assets.map((asset) => (
            <section className="card" key={asset.id}>
              <div className="section-title">{asset.title}</div>
              <p className="section-hint">{assetHeadline(asset)}</p>

              {isPreviewable(asset) && (
                <a href={assetUrl(asset.id)} target="_blank" rel="noreferrer">
                  <img
                    src={assetUrl(asset.id)}
                    alt={asset.title}
                    loading="lazy"
                    decoding="async"
                    style={{ maxWidth: '100%', borderRadius: 8, display: 'block', margin: '12px 0' }}
                  />
                </a>
              )}

              <div className="row">
                <a className="ghost" href={assetUrl(asset.id)} target="_blank" rel="noreferrer">
                  Open
                </a>
                <button className="ghost" disabled={busy} onClick={() => void onDelete(asset)}>
                  Remove
                </button>
                <span className="help">{fileSize(asset.sizeBytes)}</span>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}
