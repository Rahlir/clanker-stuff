"""Download a listing's photos to a temp dir so they can be viewed locally.

Two facts force this command to exist:

  * The image CDN serves photos only through a transform query (see
    `api.image_view_url`); a bare URL 401s.
  * The agent's file-reading tool renders only *local* image files, not
    remote URLs.

So "look at the photos" means: resolve the transformed URLs, download them
to a predictable temp dir, and hand back local paths the caller can open.
Image bytes always come from the CDN - `--from-snapshot` only governs
whether the detail JSON (the URL list) is re-fetched, not the downloads.
"""

import logging
import tempfile
from pathlib import Path

import httpx

from .api import DEFAULT_USER_AGENT, image_view_url
from .models import ListingDetail

log = logging.getLogger("sreality_hunt.images")

DEFAULT_IMAGE_LIMIT = 20
_DOWNLOAD_TIMEOUT_S = 30.0

# advert_images `kind`: 2=photo, 4=floor plan (see sreality-api-findings.md).
_KIND_LABEL = {2: "photo", 4: "floor-plan"}


def image_dir(hash_id: int) -> Path:
    """Stable per-listing temp dir; re-runs overwrite rather than accrete."""
    return Path(tempfile.gettempdir()) / "sreality-hunt" / str(hash_id)


def run_images(detail: ListingDetail, *, limit: int = DEFAULT_IMAGE_LIMIT) -> str:
    """Download up to `limit` photos and return markdown listing local paths.

    Floor plans are downloaded first (highest signal for layout questions and
    easy to lose at the tail of a long photo list); each path is labeled with
    its kind so the caller knows what it's opening.
    """
    images = [img for img in detail.advert_images if img.url]
    if not images:
        return "_(no images)_"

    images.sort(key=lambda im: (im.kind != 4, im.order))
    shown = images[:limit]

    dest = image_dir(detail.hash_id)
    dest.mkdir(parents=True, exist_ok=True)

    rows: list[str] = []
    with httpx.Client(
        timeout=_DOWNLOAD_TIMEOUT_S,
        headers={"User-Agent": DEFAULT_USER_AGENT},
        follow_redirects=True,
    ) as client:
        for i, img in enumerate(shown, start=1):
            url = image_view_url(img.url)
            if not url:
                continue
            label = _KIND_LABEL.get(img.kind, f"kind{img.kind}")
            # CDN transform emits JPEG regardless of the source extension.
            path = dest / f"{i:02d}_{label}.jpg"
            try:
                r = client.get(url)
                r.raise_for_status()
            except httpx.HTTPError as e:
                log.warning("failed to download image %s: %s", url, e)
                rows.append(f"- _failed: {label} ({e})_")
                continue
            path.write_bytes(r.content)
            rows.append(f"- `{path}` - {label}")

    n_more = len(images) - len(shown)
    header = f"Downloaded {len(shown)} image(s) to `{dest}`"
    if n_more > 0:
        header += f" ({n_more} more available; raise --limit)"
    body = "\n".join(rows) if rows else "_(no images downloaded)_"
    return f"{header}\n\n{body}\n\nRead these local paths to view the images."
