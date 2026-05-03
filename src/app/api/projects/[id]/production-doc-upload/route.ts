import { NextRequest, NextResponse } from 'next/server';
import {
  isR2Configured,
  buildProductionDocKey,
  getImagesUploadUrl,
  getImagesDownloadUrl,
  getImagesBucket,
} from '@/lib/r2';
import { logger } from '@/lib/logger';

// Document mime types we accept for production-doc attachments. Most are
// the office formats users would export from the production-doc UI or
// download from a Google Sheet. PDF and plain text are the lowest common
// denominator for editor-facing reference material.
const ALLOWED_DOC_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'application/json',
  'application/zip', // .docx/.xlsx are zip-shaped on some browsers
];

/**
 * Issue a presigned PUT URL so the browser can upload a production-doc
 * attachment straight to R2 (images bucket, prod-docs/ prefix). After the
 * upload the page calls /api/projects/[id]/media to register a row with
 * type='production_doc' — that route already populates workspace_id from
 * the project and stores r2_bucket / r2_key for URL refresh on read.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const { fileName, contentType } = await req.json();
    if (!fileName || !contentType) {
      return NextResponse.json({ error: 'fileName + contentType required' }, { status: 400 });
    }
    if (!ALLOWED_DOC_TYPES.includes(contentType)) {
      return NextResponse.json(
        { error: `Unsupported document type: ${contentType}. Accepted: PDF, DOCX, XLSX, CSV, TXT, JSON.` },
        { status: 400 },
      );
    }
    if (!isR2Configured()) {
      return NextResponse.json(
        { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
        { status: 503 },
      );
    }

    const r2Key = buildProductionDocKey(projectId, String(fileName));
    let uploadUrl: string;
    let downloadUrl: string;
    try {
      uploadUrl = await getImagesUploadUrl(r2Key, contentType);
      downloadUrl = await getImagesDownloadUrl(r2Key);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown R2 error';
      return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
    }

    return NextResponse.json(
      { uploadUrl, downloadUrl, r2Key, r2Bucket: getImagesBucket() },
      { status: 201 },
    );
  } catch (err) {
    logger.error('production-doc-upload error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to issue upload URL' },
      { status: 500 },
    );
  }
}
