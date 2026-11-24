import { randomBytes } from "node:crypto";
import type { IntakeInput } from "../artifacts.js";
import { ArchivistError } from "../errors.js";

/**
 * Duplicate reviews waiting for the contributor's choices. Like Discord's
 * pending forms, they live in memory, belong to the contributor and archive
 * that started them, expire after 15 minutes, and work once. A bot restart
 * drops them; nothing was saved yet, so the contributor submits again.
 */

export const REVIEW_LIFETIME_MS = 15 * 60_000;

export interface PendingReview {
  userId: string;
  archiveId: string;
  intake: IntakeInput;
  artifactId: string;
  /** The artifact's version when the review was shown. Applying it checks this. */
  version: number;
  expiresMs: number;
}

export class ReviewStore {
  private readonly reviews = new Map<string, PendingReview>();

  constructor(private readonly now: () => number) {}

  create(review: Omit<PendingReview, "expiresMs">): string {
    this.sweep();
    const token = randomBytes(24).toString("base64url");
    this.reviews.set(token, { ...review, expiresMs: this.now() + REVIEW_LIFETIME_MS });
    return token;
  }

  /** Takes a review for its owner. Another contributor, another archive, or an old token is refused. */
  take(token: string, userId: string, archiveId: string): PendingReview {
    this.sweep();
    const review = this.reviews.get(token);
    if (!review || review.userId !== userId || review.archiveId !== archiveId) {
      throw new ArchivistError(
        "not_found",
        "That review expired or belongs to someone else. Submit the file again to review it.",
        { reason: "review_expired" },
      );
    }
    this.reviews.delete(token);
    return review;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, review] of this.reviews)
      if (review.expiresMs <= now) this.reviews.delete(token);
  }
}
