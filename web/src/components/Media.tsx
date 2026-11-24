import { type ArtifactDetails, type ArtifactSummary, mediaUrl } from "../api.js";

type MediaInfo = Pick<
  ArtifactSummary["media"],
  "id" | "kind" | "mimeType" | "hasPreview" | "readable"
>;

/** A drawn stand-in for files without a picture: videos, audio, and unreadable files. */
function KindArt(props: { kind: string; unreadable?: boolean }) {
  return (
    <svg
      viewBox="0 0 160 120"
      role="img"
      aria-label={props.unreadable ? "File that cannot be read" : `${props.kind} file`}
    >
      <rect width="160" height="120" fill="#2b2d31" />
      {props.unreadable ? (
        <text x="80" y="64" textAnchor="middle" fill="#ff8a8d" fontSize="11">
          cannot be read
        </text>
      ) : props.kind === "video" ? (
        <>
          <circle cx="80" cy="60" r="24" fill="#1e1f22" />
          <path d="M72 46 L96 60 L72 74 Z" fill="#f2f3f5" />
        </>
      ) : (
        Array.from({ length: 18 }, (_, i) => {
          const height = 10 + ((i * 37) % 50);
          return (
            <rect
              key={i}
              x={17 + i * 7}
              y={60 - height / 2}
              width="4"
              height={height}
              rx="2"
              fill="#f2f3f5"
              opacity="0.8"
            />
          );
        })
      )}
    </svg>
  );
}

/** A small square picture for tiles and strips: the still preview when there is one. */
export function Thumb(props: { archiveId: string; media: MediaInfo }) {
  const { media } = props;
  if (!media.readable) return <KindArt kind={media.kind} unreadable />;
  if (media.kind === "image" && (media.hasPreview || media.mimeType === "image/gif")) {
    return (
      <img
        src={mediaUrl(
          props.archiveId,
          media.id,
          media.hasPreview && media.mimeType !== "image/gif",
        )}
        alt=""
        loading="lazy"
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
    );
  }
  return <KindArt kind={media.kind} />;
}

/** The file itself: images (GIFs animate), playable video and audio, or a download. */
export function FullMedia(props: { archiveId: string; artifact: ArtifactDetails }) {
  const { media } = props.artifact;
  const original = mediaUrl(props.archiveId, media.id);
  if (!media.readable) {
    return (
      <div className="media-box">
        <KindArt kind="image" unreadable />
        <a className="btn" href={`${original}?download=1`}>
          Download the original
        </a>
      </div>
    );
  }
  if (media.mimeType.startsWith("image/")) {
    const still = media.hasPreview && media.mimeType !== "image/gif";
    return (
      <a
        className="media-box"
        href={original}
        target="_blank"
        rel="noreferrer"
        title="Open the original"
      >
        <img
          src={still ? mediaUrl(props.archiveId, media.id, true) : original}
          alt={props.artifact.description}
        />
      </a>
    );
  }
  if (media.mimeType.startsWith("video/")) {
    return (
      <div className="media-box">
        <video controls preload="metadata" src={original} />
        <a className="hint" href={`${original}?download=1`}>
          Download if it does not play
        </a>
      </div>
    );
  }
  return (
    <div className="media-box">
      <KindArt kind="audio" />
      <audio controls preload="metadata" src={original} />
    </div>
  );
}
