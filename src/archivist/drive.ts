import {
  DOWNLOAD_LIMITS,
  type DownloadLimits,
  type Fetch,
  fetchFromAllowedHosts,
  transientFor,
  TransientDownloadError,
  withRetries,
  writeBody,
} from "./download.js";
import { ArchivistError } from "./errors.js";

/**
 * Public Google Drive files. Contributors paste a link to a single file in
 * any folder shared with "Anyone with the link". The bot reads it through the
 * Drive API with a server-side API key and the link's resource key. It never
 * signs anyone in, scrapes web pages, or downloads previews or thumbnails.
 *
 * Google documents the binary download at
 * https://developers.google.com/workspace/drive/api/guides/manage-downloads
 * and resource keys at
 * https://developers.google.com/workspace/drive/api/guides/resource-keys
 */

export interface DriveLink {
  fileId: string;
  resourceKey: string | null;
  url: string;
}

const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_LINK_LENGTH = 2000;

function linkError(message: string): ArchivistError {
  return new ArchivistError("invalid_input", message, { field: "drive_link" });
}

/**
 * Reads a Drive file link: `/file/d/<id>/view`, `open?id=<id>`, or
 * `uc?id=<id>`, with an optional `resourcekey`. Other parameters, such as
 * `usp=sharing`, are ignored, so every variant of a link names one source.
 */
export function parseDriveLink(text: unknown): DriveLink {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw || raw.length > MAX_LINK_LENGTH) throw linkError("Paste a Google Drive file link.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw linkError("That is not a link. Paste a Google Drive file link.");
  }
  if (url.protocol !== "https:" || !DRIVE_HOSTS.has(url.hostname)) {
    throw linkError(
      "Only Google Drive file links can be archived from a link. Attach other files instead.",
    );
  }
  const path = url.pathname;
  if (/^\/drive\/(u\/\d+\/)?folders\//.test(path) || url.searchParams.get("folder")) {
    throw linkError("That is a folder link. Open the file and copy its own link.");
  }
  if (/^\/(document|spreadsheets|presentation|forms|drawings)\//.test(path)) {
    throw linkError(
      "Google Docs, Sheets, and Slides cannot be archived. Upload an image or video file.",
    );
  }
  const fromPath = /^\/file\/d\/([^/]+)/.exec(path)?.[1];
  const fromQuery = path === "/open" || path === "/uc" ? url.searchParams.get("id") : null;
  const fileId = fromPath ?? fromQuery;
  if (!fileId || !FILE_ID.test(fileId)) {
    throw linkError("That does not look like a Google Drive file link.");
  }
  const resourceKey = url.searchParams.get("resourcekey");
  if (resourceKey !== null && !RESOURCE_KEY.test(resourceKey)) {
    throw linkError("That link's resource key is not valid.");
  }
  return { fileId, resourceKey, url: raw };
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface DriveClientOptions {
  apiKey: string | undefined;
  fetch?: Fetch;
  limits?: DownloadLimits;
}

const API = "https://www.googleapis.com/drive/v3/files/";
const ACCEPTED_TYPES = /^(image\/|video\/|application\/octet-stream$)/;

/** Google's API and download hosts, the only places a Drive request may go. */
function isGoogleHost(host: string): boolean {
  return host === "www.googleapis.com" || host.endsWith(".googleusercontent.com");
}

function notPublic(): ArchivistError {
  return new ArchivistError(
    "invalid_input",
    'Archivist cannot open that Drive file. Make sure it is shared with "Anyone with the link", or attach or upload the file instead.',
    { field: "drive_link" },
  );
}

export class DriveClient {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: Fetch;
  private readonly limits: DownloadLimits;

  constructor(options: DriveClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.limits = options.limits ?? DOWNLOAD_LIMITS;
  }

  private request(link: DriveLink, query: Record<string, string>, signal: AbortSignal) {
    if (!this.apiKey) {
      throw new ArchivistError(
        "dependency_unavailable",
        "Drive links are not set up on this bot. Attach or upload the file instead.",
      );
    }
    const url = new URL(`${API}${encodeURIComponent(link.fileId)}`);
    for (const [name, value] of Object.entries({
      ...query,
      supportsAllDrives: "true",
      key: this.apiKey,
    })) {
      url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = {};
    if (link.resourceKey)
      headers["X-Goog-Drive-Resource-Keys"] = `${link.fileId}/${link.resourceKey}`;
    return fetchFromAllowedHosts(this.fetchImpl, url, { headers, signal }, isGoogleHost);
  }

  /** Reads a file's metadata and refuses anything that is not a downloadable media file. */
  async metadata(link: DriveLink): Promise<DriveFile> {
    return withRetries(this.limits, async (controller) => {
      const response = await this.request(
        link,
        { fields: "id,name,mimeType,size,trashed,capabilities/canDownload" },
        controller.signal,
      );
      await this.checkStatus(response);
      const file = (await response.json()) as {
        id?: string;
        name?: string;
        mimeType?: string;
        size?: string;
        trashed?: boolean;
        capabilities?: { canDownload?: boolean };
      };
      const mimeType = file.mimeType ?? "";
      if (mimeType === "application/vnd.google-apps.folder") {
        throw new ArchivistError(
          "invalid_input",
          "That is a folder. Open the file and copy its own link.",
          {
            field: "drive_link",
          },
        );
      }
      if (mimeType === "application/vnd.google-apps.shortcut") {
        throw new ArchivistError(
          "invalid_input",
          "That is a Drive shortcut. Copy the link of the file it points to.",
          {
            field: "drive_link",
          },
        );
      }
      if (mimeType.startsWith("application/vnd.google-apps.")) {
        throw new ArchivistError(
          "invalid_input",
          "Google Docs, Sheets, Slides, and other Google files cannot be archived. Upload an image or video file.",
          { field: "drive_link" },
        );
      }
      if (file.trashed || file.capabilities?.canDownload === false) throw notPublic();
      if (!ACCEPTED_TYPES.test(mimeType)) {
        throw new ArchivistError(
          "unsupported_media_type",
          "Only JPEG, PNG, WebP, GIF, and MP4 files can be archived.",
          { field: "drive_link" },
        );
      }
      const size = Number(file.size);
      if (Number.isFinite(size) && size > this.limits.maxBytes) {
        throw new ArchivistError("media_too_large", "Files can be at most 100 MiB.", {
          field: "drive_link",
        });
      }
      return { id: file.id ?? link.fileId, name: file.name ?? "", mimeType, size };
    });
  }

  /** Downloads the file's original bytes into `file`. */
  async download(link: DriveLink, file: string): Promise<number> {
    return withRetries(this.limits, async (controller) => {
      const response = await this.request(link, { alt: "media" }, controller.signal);
      await this.checkStatus(response);
      return writeBody(response, file, this.limits, controller);
    });
  }

  private async checkStatus(response: Response): Promise<void> {
    if (response.ok) return;
    const transient = transientFor(response);
    if (transient) {
      await response.body?.cancel();
      throw transient;
    }
    // Drive reports rate limits as 403 with a reason in the body.
    let reason = "";
    try {
      const body = (await response.json()) as { error?: { errors?: { reason?: string }[] } };
      reason = body.error?.errors?.[0]?.reason ?? "";
    } catch {
      // A body that is not JSON gives no reason.
    }
    if (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason)) {
      throw new TransientDownloadError("rate limited", true);
    }
    if (response.status === 400 && /keyInvalid/.test(reason)) {
      throw new ArchivistError(
        "dependency_unavailable",
        "The bot's Drive access is misconfigured. Attach or upload the file instead, and tell the bot owner.",
      );
    }
    throw notPublic();
  }
}
