import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getUserSettings, updateUserSettings } from '@/lib/user-settings';
import {
  clampVariantCount,
  DEFAULT_VARIANT_COUNT,
} from '@/lib/thumbnail-variants';
import { resolveThumbnailStyle, DEFAULT_THUMBNAIL_STYLE_ID } from '@/lib/thumbnail-styles';

/**
 * CRUD endpoint for the thumbnail-variant settings introduced 2026-06-09.
 *
 * Bundles the four related fields into a single route because the page's
 * variants toggle reads/writes them as a unit:
 *   - `variantCount` (1..3, clamped on read AND write)
 *   - `variantsEnabled` (boolean — controls whether fan-out fires at all)
 *   - `defaultImageModel` (matches MODEL_MAP keys in the image route)
 *   - `defaultStyle` (matches THUMBNAIL_STYLES ids)
 *
 * Backing store: `collaborators.encrypted_settings` (versioned JSON), via
 * the existing parseUserSettings / updateUserSettings plumbing. No new
 * migration — the four fields were added to the `UserSettings` shape
 * in Phase 1 and lain dormant until this route landed.
 *
 * GET response includes `isExplicit` flags so the client knows whether
 * each field is a user choice or the library default. Useful for the
 * settings UI to distinguish "user picked 3" from "didn't choose, fell
 * back to 3."
 */

interface GetResponse {
  variantCount: number;
  variantsEnabled: boolean;
  defaultImageModel: string | null;
  defaultStyle: string;
  isExplicit: {
    variantCount: boolean;
    variantsEnabled: boolean;
    defaultImageModel: boolean;
    defaultStyle: boolean;
  };
}

const DEFAULT_IMAGE_MODEL = 'gpt-image-2-t2i';
const DEFAULT_STYLE = DEFAULT_THUMBNAIL_STYLE_ID;

export const GET = apiRoute.authed(async (session) => {
  const settings = await getUserSettings(session.uid);
  const storedCount = settings.thumbnail_variant_count ?? null;
  const storedEnabled = settings.thumbnail_variants_enabled ?? null;
  const storedModel = settings.thumbnail_default_image_model ?? null;
  const storedStyle = settings.thumbnail_default_style ?? null;

  const response: GetResponse = {
    variantCount: typeof storedCount === 'number' ? clampVariantCount(storedCount) : DEFAULT_VARIANT_COUNT,
    variantsEnabled: typeof storedEnabled === 'boolean' ? storedEnabled : true,
    defaultImageModel: storedModel || DEFAULT_IMAGE_MODEL,
    defaultStyle: storedStyle || DEFAULT_STYLE,
    isExplicit: {
      variantCount: storedCount !== null && storedCount !== undefined,
      variantsEnabled: storedEnabled !== null && storedEnabled !== undefined,
      defaultImageModel: storedModel !== null && storedModel !== undefined,
      defaultStyle: storedStyle !== null && storedStyle !== undefined,
    },
  };
  return NextResponse.json(response);
});

interface PutBody {
  variantCount?: number | null;
  variantsEnabled?: boolean | null;
  defaultImageModel?: string | null;
  defaultStyle?: string | null;
}

export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }
  const input = body as PutBody;
  const patch: Record<string, unknown> = {};

  // variantCount — number in [1,3] or null to clear.
  if (input.variantCount !== undefined) {
    if (input.variantCount === null) {
      patch.thumbnail_variant_count = null;
    } else if (typeof input.variantCount === 'number' && Number.isFinite(input.variantCount)) {
      patch.thumbnail_variant_count = clampVariantCount(input.variantCount);
    } else {
      return NextResponse.json({ error: 'variantCount must be a number or null' }, { status: 400 });
    }
  }

  // variantsEnabled — boolean or null.
  if (input.variantsEnabled !== undefined) {
    if (input.variantsEnabled === null) {
      patch.thumbnail_variants_enabled = null;
    } else if (typeof input.variantsEnabled === 'boolean') {
      patch.thumbnail_variants_enabled = input.variantsEnabled;
    } else {
      return NextResponse.json({ error: 'variantsEnabled must be a boolean or null' }, { status: 400 });
    }
  }

  // defaultImageModel — string ≤ 100 chars, or null to clear. We don't
  // validate against MODEL_MAP here because that lives behind the image
  // route's `eslint-disable no-restricted-syntax`; a retired id falls
  // back to the registry default at consumption time.
  if (input.defaultImageModel !== undefined) {
    if (input.defaultImageModel === null || input.defaultImageModel === '') {
      patch.thumbnail_default_image_model = null;
    } else if (typeof input.defaultImageModel === 'string') {
      if (input.defaultImageModel.length > 100) {
        return NextResponse.json({ error: 'defaultImageModel too long' }, { status: 400 });
      }
      patch.thumbnail_default_image_model = input.defaultImageModel;
    } else {
      return NextResponse.json({ error: 'defaultImageModel must be a string or null' }, { status: 400 });
    }
  }

  // defaultStyle — must resolve against THUMBNAIL_STYLES OR be null.
  // A bad style id silently restores nothing on the panel side, so
  // validating here saves a debugging round-trip.
  if (input.defaultStyle !== undefined) {
    if (input.defaultStyle === null || input.defaultStyle === '') {
      patch.thumbnail_default_style = null;
    } else if (typeof input.defaultStyle === 'string') {
      if (!resolveThumbnailStyle(input.defaultStyle)) {
        return NextResponse.json({ error: `Unknown thumbnail style: ${input.defaultStyle}` }, { status: 400 });
      }
      patch.thumbnail_default_style = input.defaultStyle;
    } else {
      return NextResponse.json({ error: 'defaultStyle must be a string or null' }, { status: 400 });
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No recognized fields in body' }, { status: 400 });
  }

  await updateUserSettings(session.uid, patch);
  return NextResponse.json({ ok: true, patched: Object.keys(patch) });
});
