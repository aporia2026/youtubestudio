'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadReviewVideo, UploadError, type UploadProgress } from '@/lib/upload-video-client';

interface Collaborator {
  id: string;
  name: string;
  email: string | null;
  role: string;
  color: string;
  personal_token?: string | null;
}

interface EditorAssignment {
  id: string;
  editor_id: string;
  status: string;
  editor_notes: string | null;
  deadline: string | null;
  review_project_id: string | null;
  editor_name: string;
  editor_email: string | null;
  editor_color: string;
  editor_personal_token: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

interface ImageAsset {
  id: string;
  name: string;
  url: string;
  size_bytes?: number | null;
  notes: string | null;
  created_at: string;
}

interface ProductionDocAsset {
  id: string;
  project_id: string;
  project_title?: string | null;
  name: string;
  url: string;
  source: string | null;
  r2_bucket?: string | null;
  r2_key?: string | null;
  size_bytes?: number | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

interface VoiceoverAsset {
  id: string;
  project_id: string;
  project_title?: string | null;
  name: string;
  url: string;
  source: string | null;
  r2_bucket?: string | null;
  r2_key?: string | null;
  blob_pathname?: string | null;
  size_bytes?: number | null;
  duration_seconds?: number | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

interface EditorUploadVersion {
  id: string;
  version_number: number;
  thumbnail_url: string | null;
  duration_ms: number | null;
  uploaded_by: string | null;
  file_size: number | null;
  created_at: string;
  review_project_id: string;
  unresolved_comment_count: number;
}

const PROD_DOC_ACCEPT = '.pdf,.docx,.doc,.xlsx,.xls,.csv,.txt,.json,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,application/json';

// Matches the ALLOWED_AUDIO list on /api/projects/[id]/voiceover-upload — the
// presign endpoint rejects anything else, so we mirror it here to fail fast
// in the browser rather than round-trip a bad file.
const VOICEOVER_ACCEPT = '.mp3,.m4a,.aac,.wav,.ogg,.webm,.flac,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/flac';

interface Props { projectId: string }

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  assigned:  { bg: 'rgba(234,179,8,0.15)', text: '#eab308' },
  editing:   { bg: 'rgba(124,58,237,0.18)', text: '#a78bfa' },
  submitted: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  approved:  { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
  completed: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
};

function timeAgo(s: string | null) {
  if (!s) return 'never';
  const ms = Date.now() - new Date(s).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function EditorTab({ projectId }: Props) {
  const [editors, setEditors] = useState<Collaborator[]>([]);
  const [assignments, setAssignments] = useState<EditorAssignment[]>([]);
  const [imageRefs, setImageRefs] = useState<ImageAsset[]>([]);
  const [thumbnails, setThumbnails] = useState<ImageAsset[]>([]);
  const [productionDocs, setProductionDocs] = useState<ProductionDocAsset[]>([]);
  const [voiceovers, setVoiceovers] = useState<VoiceoverAsset[]>([]);
  const [loading, setLoading] = useState(true);

  // Production-doc state — three add paths (file upload / Google-Sheet URL /
  // pick from workspace library), each with its own pending flag so the UI
  // can show the right button label.
  const [uploadingProdDoc, setUploadingProdDoc] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetName, setSheetName] = useState('');
  const [addingSheet, setAddingSheet] = useState(false);
  const [showProdDocLibrary, setShowProdDocLibrary] = useState(false);
  const [prodDocLibrary, setProdDocLibrary] = useState<ProductionDocAsset[]>([]);
  const [prodDocLibLoading, setProdDocLibLoading] = useState(false);
  const [prodDocLibError, setProdDocLibError] = useState<string | null>(null);
  const [attachingProdDoc, setAttachingProdDoc] = useState<string | null>(null);
  const prodDocInputRef = useRef<HTMLInputElement>(null);

  // Voiceover state — same three-state shape as production-doc (upload busy
  // flag, library modal, attach-in-flight id). Voiceovers reuse the existing
  // /voiceover-upload presign route + /voiceover-library picker so this UI
  // is a thin wrapper around endpoints the project page already uses.
  const [uploadingVoiceover, setUploadingVoiceover] = useState(false);
  const [showVoiceoverLibrary, setShowVoiceoverLibrary] = useState(false);
  const [voiceoverLibrary, setVoiceoverLibrary] = useState<VoiceoverAsset[]>([]);
  const [voiceoverLibLoading, setVoiceoverLibLoading] = useState(false);
  const [voiceoverLibError, setVoiceoverLibError] = useState<string | null>(null);
  const [attachingVoiceover, setAttachingVoiceover] = useState<string | null>(null);
  const voiceoverInputRef = useRef<HTMLInputElement>(null);

  // Assign UI state
  const [showAssign, setShowAssign] = useState(false);
  const [pickedEditorId, setPickedEditorId] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [editorNotes, setEditorNotes] = useState('');
  const [deadline, setDeadline] = useState('');
  const [assigning, setAssigning] = useState(false);

  // Upload state
  const [uploadingRef, setUploadingRef] = useState(false);
  const [uploadingThumb, setUploadingThumb] = useState(false);
  const refInputRef = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  // Editor-video upload state — owner uploads a finished video the editor
  // sent through Upwork. Goes through the same review_versions / comments
  // pipeline the editor's own dashboard upload does.
  const [editorUploads, setEditorUploads] = useState<EditorUploadVersion[]>([]);
  const [editorReviewProjectId, setEditorReviewProjectId] = useState<string | null>(null);
  const [editorUploadingForId, setEditorUploadingForId] = useState<string | null>(null);
  const [editorUploadProgress, setEditorUploadProgress] = useState<UploadProgress | null>(null);
  const [editorUploadNote, setEditorUploadNote] = useState('');
  const [editorEnableCompression, setEditorEnableCompression] = useState(true);
  const [editorUploadController, setEditorUploadController] = useState<AbortController | null>(null);

  useEffect(() => { load(); }, [projectId]);

  async function load() {
    setLoading(true);
    try {
      const [a, c, refs, thumbs, mediaRes, uploadsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/editors`).then(r => r.ok ? r.json() : []),
        fetch(`/api/team/collaborators?role=editor`).then(r => r.ok ? r.json() : []),
        fetch(`/api/projects/${projectId}/image-refs`).then(r => r.ok ? r.json() : []),
        fetch(`/api/projects/${projectId}/thumbnails`).then(r => r.ok ? r.json() : []),
        // Production-doc attachments live on the unified media table.
        fetch(`/api/projects/${projectId}/media`).then(r => r.ok ? r.json() : { assets: [] }),
        fetch(`/api/projects/${projectId}/editor-uploads`).then(r => r.ok ? r.json() : { versions: [], reviewProjectId: null }),
      ]);
      // production-doc attachments are stored as type='document' +
      // metadata.kind='production_doc' (the type column has a fixed CHECK
      // enum so we lean on the metadata key for the subtype). Voiceovers
      // are first-class type='voiceover' rows on the same table so they
      // come back in the same response — split by type here.
      const allAssets = (mediaRes?.assets ?? []) as Array<(ProductionDocAsset & VoiceoverAsset) & { type?: string }>;
      setProductionDocs(
        allAssets.filter(m => m.type === 'document' && (m.metadata as { kind?: string } | null)?.kind === 'production_doc'),
      );
      setVoiceovers(allAssets.filter(m => m.type === 'voiceover'));
      setAssignments(a);
      setEditors(c);
      setImageRefs(refs);
      setThumbnails(thumbs);
      setEditorUploads((uploadsRes?.versions ?? []) as EditorUploadVersion[]);
      setEditorReviewProjectId((uploadsRes?.reviewProjectId as string | null) ?? null);
    } catch {} finally { setLoading(false); }
  }

  async function handleAssign() {
    setAssigning(true);
    try {
      let editorId = pickedEditorId;

      // Inline-create new editor if needed
      if (!editorId && newName.trim()) {
        const palette = ['#3b82f6', '#7c3aed', '#06b6d4', '#f59e0b', '#22c55e', '#ec4899'];
        const cRes = await fetch('/api/team/collaborators', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName.trim(), email: newEmail.trim() || undefined, role: 'editor', color: palette[editors.length % palette.length] }),
        });
        if (!cRes.ok) throw new Error('Failed to create editor');
        const c = await cRes.json();
        editorId = c.id;
        setEditors(prev => [...prev, c]);
      }
      if (!editorId) { toast.error('Pick an editor or enter a name'); setAssigning(false); return; }

      const res = await fetch(`/api/projects/${projectId}/editors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editor_id: editorId,
          editor_notes: editorNotes.trim() || undefined,
          deadline: deadline || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed');
      }
      toast.success('Editor assigned');
      setShowAssign(false);
      setPickedEditorId('');
      setNewName('');
      setNewEmail('');
      setEditorNotes('');
      setDeadline('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally { setAssigning(false); }
  }

  async function handleRevoke(assignmentId: string, name: string) {
    if (!confirm(`Revoke ${name}'s access to this project?`)) return;
    await fetch(`/api/projects/${projectId}/editors/${assignmentId}`, { method: 'DELETE' });
    setAssignments(prev => prev.filter(a => a.id !== assignmentId));
    toast.success('Access revoked');
  }

  function copyDashboardLink(token: string | null) {
    if (!token) { toast.error('No personal token on this editor'); return; }
    navigator.clipboard.writeText(`${window.location.origin}/editor/${token}`);
    toast.success('Dashboard link copied');
  }

  // ── Upload flows ──────────────────────────────────────────────────────────
  async function uploadFile(kind: 'image-refs' | 'thumbnails', file: File) {
    if (!file.type.startsWith('image/')) { toast.error('Image files only'); return; }
    const setBusy = kind === 'image-refs' ? setUploadingRef : setUploadingThumb;
    setBusy(true);
    try {
      const reserveRes = await fetch(`/api/projects/${projectId}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!reserveRes.ok) {
        const err = await reserveRes.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${reserveRes.status}`);
      }
      const { uploadUrl } = await reserveRes.json();
      const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!putRes.ok) throw new Error(`R2 rejected upload (HTTP ${putRes.status}). Check bucket CORS.`);
      toast.success(kind === 'image-refs' ? 'Reference added' : 'Thumbnail added');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally { setBusy(false); }
  }

  async function deleteAsset(kind: 'image-refs' | 'thumbnails', assetId: string) {
    if (!confirm('Delete this image?')) return;
    await fetch(`/api/projects/${projectId}/${kind}/${assetId}`, { method: 'DELETE' });
    if (kind === 'image-refs') setImageRefs(prev => prev.filter(a => a.id !== assetId));
    else setThumbnails(prev => prev.filter(a => a.id !== assetId));
    toast.success('Deleted');
  }

  // ── Production-doc flows ─────────────────────────────────────────────────
  async function uploadProductionDoc(file: File) {
    setUploadingProdDoc(true);
    try {
      const presignRes = await fetch(`/api/projects/${projectId}/production-doc-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type || 'application/octet-stream' }),
      });
      if (!presignRes.ok) {
        const err = await presignRes.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${presignRes.status}`);
      }
      const { uploadUrl, downloadUrl, r2Key, r2Bucket } = await presignRes.json();
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (HTTP ${putRes.status}). Check bucket CORS.`);

      const registerRes = await fetch(`/api/projects/${projectId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // type='document' is what the CHECK constraint allows; the
          // production-doc subtype is carried on metadata.kind.
          type: 'document',
          source: 'upload',
          name: file.name,
          url: downloadUrl,
          r2_bucket: r2Bucket,
          r2_key: r2Key,
          size_bytes: file.size,
          metadata: { kind: 'production_doc', source_kind: 'file', mime: file.type },
        }),
      });
      if (!registerRes.ok) {
        const err = await registerRes.json().catch(() => ({}));
        throw new Error(err.error || `Failed to register doc (${registerRes.status})`);
      }
      toast.success('Production doc attached');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadingProdDoc(false);
    }
  }

  async function attachSheetUrl() {
    const url = sheetUrl.trim();
    if (!url) { toast.error('Paste a Google Sheet URL first'); return; }
    try {
      // Light validation — must be http(s) + look like a Google host. Keeps
      // the editor's open-link flow predictable; arbitrary URLs are still
      // possible via the existing /media POST.
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('URL must be http or https');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Invalid URL');
      return;
    }
    setAddingSheet(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // type='document' is what the CHECK constraint allows; the
          // production-doc subtype is carried on metadata.kind, with a
          // source_kind sub-marker for the sheet vs file distinction.
          type: 'document',
          source: 'url',
          name: sheetName.trim() || 'Production Doc (Google Sheet)',
          url,
          metadata: { kind: 'production_doc', source_kind: 'google_sheet' },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed (${res.status})`);
      }
      toast.success('Google Sheet linked');
      setSheetUrl('');
      setSheetName('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to link sheet');
    } finally {
      setAddingSheet(false);
    }
  }

  async function openProductionDocLibrary() {
    setShowProdDocLibrary(true);
    setProdDocLibLoading(true);
    setProdDocLibError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/production-doc-library`);
      if (!res.ok) throw new Error(`Failed to load library (${res.status})`);
      const data = await res.json();
      setProdDocLibrary((data?.docs ?? []) as ProductionDocAsset[]);
    } catch (e) {
      setProdDocLibError(e instanceof Error ? e.message : 'Failed to load library');
    } finally {
      setProdDocLibLoading(false);
    }
  }

  async function attachExistingProductionDoc(item: ProductionDocAsset) {
    if (attachingProdDoc) return;
    setAttachingProdDoc(item.id);
    try {
      const res = await fetch(`/api/projects/${projectId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // type='document' (CHECK enum) + metadata.kind='production_doc'
          // for the subtype; source must be one of upload|url so map a
          // library link to 'upload' when the underlying file is in R2.
          type: 'document',
          source: item.r2_key ? 'upload' : (item.source === 'upload' ? 'upload' : 'url'),
          name: item.name || 'Linked production doc',
          url: item.url,
          r2_bucket: item.r2_bucket,
          r2_key: item.r2_key,
          size_bytes: item.size_bytes,
          metadata: {
            ...(item.metadata || {}),
            kind: 'production_doc',
            linked_from_asset_id: item.id,
            linked_from_project_id: item.project_id,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to attach (${res.status})`);
      }
      toast.success('Attached');
      setShowProdDocLibrary(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to attach');
    } finally {
      setAttachingProdDoc(null);
    }
  }

  async function deleteProductionDoc(assetId: string) {
    if (!confirm('Detach this production doc from the project? The original file in R2 (or library) is not removed.')) return;
    try {
      const res = await fetch(`/api/media/${assetId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setProductionDocs(prev => prev.filter(a => a.id !== assetId));
      toast.success('Detached');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to detach');
    }
  }

  // ── Voiceover flows ──────────────────────────────────────────────────────
  // Two add paths (upload / library pick), one detach. Mirrors the production
  // doc flow but uses the existing /voiceover-upload (R2 narration bucket
  // presign) and /voiceover-library (workspace-scoped picker) routes the
  // project page already relies on. Narrator-approved voiceovers land here
  // automatically because /api/narrator/.../approve-full inserts the same
  // media_assets row this UI reads.
  async function uploadVoiceover(file: File) {
    setUploadingVoiceover(true);
    try {
      const presignRes = await fetch(`/api/projects/${projectId}/voiceover-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type || 'audio/mpeg' }),
      });
      if (!presignRes.ok) {
        const err = await presignRes.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${presignRes.status}`);
      }
      const { uploadUrl, downloadUrl, r2Key, r2Bucket } = await presignRes.json();

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'audio/mpeg' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (HTTP ${putRes.status}). Check bucket CORS.`);

      const registerRes = await fetch(`/api/projects/${projectId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'voiceover',
          source: 'upload',
          name: file.name,
          url: downloadUrl,
          r2_bucket: r2Bucket,
          r2_key: r2Key,
          size_bytes: file.size,
        }),
      });
      if (!registerRes.ok) {
        const err = await registerRes.json().catch(() => ({}));
        throw new Error(err.error || `Failed to register voiceover (${registerRes.status})`);
      }
      toast.success('Voiceover uploaded');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadingVoiceover(false);
    }
  }

  async function openVoiceoverLibrary() {
    setShowVoiceoverLibrary(true);
    setVoiceoverLibLoading(true);
    setVoiceoverLibError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/voiceover-library`);
      if (!res.ok) throw new Error(`Failed to load library (${res.status})`);
      const data = await res.json();
      setVoiceoverLibrary((data?.voiceovers ?? []) as VoiceoverAsset[]);
    } catch (e) {
      setVoiceoverLibError(e instanceof Error ? e.message : 'Failed to load library');
    } finally {
      setVoiceoverLibLoading(false);
    }
  }

  async function attachExistingVoiceover(item: VoiceoverAsset) {
    if (attachingVoiceover) return;
    setAttachingVoiceover(item.id);
    try {
      const res = await fetch(`/api/projects/${projectId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'voiceover',
          // Matches the project page's attach contract: r2-link when the
          // underlying file lives in R2 (most cases), url for externally
          // hosted voiceovers.
          source: item.r2_key ? 'r2-link' : 'url',
          name: item.name || 'Linked voiceover',
          url: item.url,
          r2_bucket: item.r2_bucket,
          r2_key: item.r2_key,
          blob_pathname: item.blob_pathname,
          size_bytes: item.size_bytes,
          duration_seconds: item.duration_seconds,
          metadata: {
            ...(item.metadata || {}),
            linked_from_asset_id: item.id,
            linked_from_project_id: item.project_id,
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to attach (${res.status})`);
      }
      toast.success('Voiceover attached');
      setShowVoiceoverLibrary(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to attach');
    } finally {
      setAttachingVoiceover(null);
    }
  }

  async function deleteVoiceover(assetId: string) {
    if (!confirm('Detach this voiceover from the project? The original audio file in R2 (or library) is not removed.')) return;
    try {
      const res = await fetch(`/api/media/${assetId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      setVoiceovers(prev => prev.filter(a => a.id !== assetId));
      toast.success('Detached');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to detach');
    }
  }

  // ── Editor-video upload (owner side) ──────────────────────────────────────
  // Owner downloads a video from Upwork (or wherever the editor sent it),
  // drops it here, and the file flows through the same compress → presign
  // → R2 PUT → metadata-confirm pipeline the editor's own dashboard uses.
  // Lands as a new review_version on the editor's assignment so it shows
  // up in their dashboard automatically and the owner can leave timestamped
  // comments through the existing /reviews/[id] surface.

  function startEditorUpload(file: File) {
    // Mirror the server-side filter in /api/projects/[id]/editor-uploads:
    // only non-completed assignments are eligible. A completed assignment
    // shouldn't accept new versions silently.
    const eligible = assignments.filter(a => a.status !== 'completed');
    if (eligible.length === 0) {
      toast.error('Assign an editor to this project before uploading their video.');
      return;
    }
    if (eligible.length > 1) {
      toast.error('This project has multiple active editors. Multi-editor support coming soon — for now, complete or revoke the unused assignments.');
      return;
    }
    runEditorUpload(file, eligible[0].id);
  }

  async function runEditorUpload(file: File, assignmentId: string) {
    if (!file.type.startsWith('video/')) {
      toast.error('Please choose a video file');
      return;
    }
    const controller = new AbortController();
    setEditorUploadController(controller);
    setEditorUploadingForId(assignmentId);
    setEditorUploadProgress({
      phase: 'compressing',
      compressFraction: 0,
      uploadPercent: 0,
      compressionSavedPct: null,
    });

    try {
      await uploadReviewVideo({
        file,
        enableCompression: editorEnableCompression,
        signal: controller.signal,
        onProgress: state => setEditorUploadProgress(state),
        uploadThumbnail: async blob => {
          // Same /api/upload contract the editor's dashboard uses for thumbnails.
          try {
            const fd = new FormData();
            fd.append('file', blob, 'thumbnail.jpg');
            fd.append('type', 'image');
            const r = await fetch('/api/upload', { method: 'POST', body: fd });
            if (!r.ok) return null;
            return (await r.json()).url ?? null;
          } catch {
            return null;
          }
        },
        reservePresignedUrl: async input => {
          const note = editorUploadNote.trim();
          const res = await fetch(`/api/projects/${projectId}/editor-uploads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileName: input.fileName,
              contentType: input.contentType,
              fileSize: input.fileSize,
              editorAssignmentId: assignmentId,
              note: note || undefined,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Server returned ${res.status}`);
          }
          const body = await res.json();
          return { uploadUrl: body.uploadUrl, versionId: body.versionId };
        },
        confirmMetadata: async input => {
          await fetch(`/api/projects/${projectId}/editor-uploads`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          });
        },
      });
      toast.success('Video uploaded — editor sees it on their dashboard');
      setEditorUploadNote('');
      await load();
    } catch (err) {
      if (err instanceof UploadError && err.code === 'ABORTED') {
        // Cancel is intentional — quiet toast, no error styling.
        toast('Upload cancelled');
      } else {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        toast.error(`Upload failed: ${msg}`);
      }
    } finally {
      setEditorUploadingForId(null);
      setEditorUploadProgress(null);
      setEditorUploadController(null);
    }
  }

  function cancelEditorUpload() {
    editorUploadController?.abort();
  }

  if (loading) {
    return <div className="py-10 text-center"><div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} /></div>;
  }

  // Filter out editors already assigned for the picker
  const assignedEditorIds = new Set(assignments.map(a => a.editor_id));
  const availableEditors = editors.filter(e => !assignedEditorIds.has(e.id));

  return (
    <div className="space-y-6">
      {/* Editors */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Editors</h3>
          <button
            onClick={() => setShowAssign(s => !s)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}
          >
            {showAssign ? 'Cancel' : '+ Assign Editor'}
          </button>
        </div>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
          Editors get their own dashboard with the script, references, thumbnails, and an upload button.
        </p>

        {showAssign && (
          <div className="p-3 rounded-lg space-y-3 mb-4" style={{ background: 'var(--bg-primary)' }}>
            {availableEditors.length > 0 && (
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Existing editor</label>
                <select
                  value={pickedEditorId}
                  onChange={e => { setPickedEditorId(e.target.value); if (e.target.value) { setNewName(''); setNewEmail(''); } }}
                  className="w-full px-3 py-1.5 rounded-lg text-sm cursor-pointer"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  <option value="">— Select an editor —</option>
                  {availableEditors.map(e => <option key={e.id} value={e.id}>{e.name}{e.email ? ` · ${e.email}` : ''}</option>)}
                </select>
              </div>
            )}

            {!pickedEditorId && (
              <div className="space-y-2">
                {availableEditors.length > 0 && <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Or add a new editor</div>}
                <div className="grid grid-cols-2 gap-2">
                  <input placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)}
                    className="px-3 py-1.5 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  <input placeholder="Email (optional)" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                    className="px-3 py-1.5 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                </div>
              </div>
            )}

            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Notes for the editor (optional)</label>
              <textarea value={editorNotes} onChange={e => setEditorNotes(e.target.value)} rows={2}
                placeholder="Style direction, references to mimic, must-haves…"
                className="w-full px-3 py-1.5 rounded-lg text-sm resize-none"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            </div>

            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Deadline (optional)</label>
              <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
                className="px-3 py-1.5 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAssign(false)} className="text-xs px-3 py-1.5 cursor-pointer" style={{ color: 'var(--text-muted)' }}>Cancel</button>
              <button onClick={handleAssign} disabled={assigning || (!pickedEditorId && !newName.trim())}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 cursor-pointer"
                style={{ background: '#7c3aed' }}>
                {assigning ? 'Assigning...' : 'Assign & generate dashboard link'}
              </button>
            </div>
          </div>
        )}

        {assignments.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No editors assigned yet</p>
        ) : (
          <div className="space-y-2">
            {assignments.map(a => {
              const sc = STATUS_COLORS[a.status] || STATUS_COLORS.assigned;
              return (
                <div key={a.id} className="flex items-center gap-3 p-2.5 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0" style={{ background: a.editor_color }}>
                    {(a.editor_name || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{a.editor_name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: sc.bg, color: sc.text }}>{a.status}</span>
                    </div>
                    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {a.editor_email && <span>{a.editor_email} · </span>}
                      {a.last_accessed_at ? `last viewed ${timeAgo(a.last_accessed_at)}` : 'never accessed'}
                    </p>
                  </div>
                  <a
                    href={`/messages?with=${a.editor_id}`}
                    className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-cyan-500/10 cursor-pointer flex items-center gap-1"
                    style={{ color: '#06b6d4', background: 'rgba(6,182,212,0.1)' }}
                    title={`Open chat with ${a.editor_name}`}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    Message
                  </a>
                  <button onClick={() => copyDashboardLink(a.editor_personal_token)} className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-purple-500/10 cursor-pointer"
                    style={{ color: '#a78bfa', background: 'rgba(124,58,237,0.1)' }}>📋 Dashboard link</button>
                  <button onClick={() => handleRevoke(a.id, a.editor_name)} className="p-1.5 rounded hover:bg-red-500/10 cursor-pointer" title="Revoke access">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Image refs */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Image references</h3>
          <input
            ref={refInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile('image-refs', f); if (e.target) e.target.value = ''; }}
          />
          <button onClick={() => refInputRef.current?.click()} disabled={uploadingRef}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
            {uploadingRef ? 'Uploading…' : '+ Add reference'}
          </button>
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Stored in your <code>images</code> bucket. Editors see these on their dashboard.
        </p>
        {imageRefs.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No image references yet</p>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {imageRefs.map(img => (
              <div key={img.id} className="relative group rounded-lg overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                <img src={img.url} alt={img.name} className="w-full h-24 object-cover" />
                <button onClick={() => deleteAsset('image-refs', img.id)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Thumbnails */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Thumbnails</h3>
          <input
            ref={thumbInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile('thumbnails', f); if (e.target) e.target.value = ''; }}
          />
          <button onClick={() => thumbInputRef.current?.click()} disabled={uploadingThumb}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
            {uploadingThumb ? 'Uploading…' : '+ Add thumbnail'}
          </button>
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Stored in your <code>images</code> bucket under <code>thumbnails/</code>.
        </p>
        {thumbnails.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No thumbnails yet</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {thumbnails.map(t => (
              <div key={t.id} className="relative group rounded-lg overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                <img src={t.url} alt={t.name} className="w-full aspect-video object-cover" />
                <button onClick={() => deleteAsset('thumbnails', t.id)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Production Doc — three add paths so the editor always has the
          shot-by-shot reference. Files land in the images bucket under
          prod-docs/; sheet links and library picks just store a URL row.
          Existing attachments are listed below with open + detach. */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Production Doc</h3>
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Attach the shot-by-shot doc the editor should follow. PDF / DOCX / XLSX / CSV / TXT / JSON, a Google Sheet link, or pick from your workspace library.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          {/* Upload */}
          <div>
            <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>Upload file</p>
            <input
              ref={prodDocInputRef}
              type="file"
              accept={PROD_DOC_ACCEPT}
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadProductionDoc(f); if (e.target) e.target.value = ''; }}
            />
            <button
              onClick={() => prodDocInputRef.current?.click()}
              disabled={uploadingProdDoc}
              className="w-full px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
              style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed', border: '1px solid rgba(124,58,237,0.25)' }}
            >
              {uploadingProdDoc ? 'Uploading…' : '⬆️ Upload'}
            </button>
          </div>

          {/* Library */}
          <div>
            <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>Pick from library</p>
            <button
              onClick={openProductionDocLibrary}
              className="w-full px-3 py-2 rounded-lg text-xs font-medium cursor-pointer"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Reuse a production doc attached to another project in this workspace"
            >
              📚 Browse library
            </button>
          </div>

          {/* Sheet link */}
          <div>
            <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>Google Sheet link</p>
            <div className="flex gap-1">
              <input
                value={sheetUrl}
                onChange={e => setSheetUrl(e.target.value)}
                placeholder="https://docs.google.com/…"
                className="flex-1 px-2 py-2 rounded-lg text-xs"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <button
                onClick={attachSheetUrl}
                disabled={addingSheet || !sheetUrl.trim()}
                className="px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
                style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
              >
                {addingSheet ? '…' : 'Add'}
              </button>
            </div>
            <input
              value={sheetName}
              onChange={e => setSheetName(e.target.value)}
              placeholder="Optional label (e.g. 'v3 shotlist')"
              className="w-full mt-1 px-2 py-1 rounded-lg text-[11px]"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        {productionDocs.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No production doc attached yet</p>
        ) : (
          <div className="space-y-2">
            {productionDocs.map(d => {
              const meta = (d.metadata || {}) as { source_kind?: string; linked_from_asset_id?: string };
              const isSheet = meta.source_kind === 'google_sheet';
              const isLinked = !!meta.linked_from_asset_id;
              return (
                <div
                  key={d.id}
                  className="flex items-center gap-3 p-2.5 rounded-lg"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
                >
                  <span className="text-base">{isSheet ? '📊' : '📄'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {isSheet ? 'Google Sheet' : (isLinked ? 'Linked from library' : (d.r2_key ? 'Uploaded file' : 'External URL'))}
                      {d.size_bytes ? ` · ${(d.size_bytes / 1024 / 1024).toFixed(1)} MB` : ''}
                      {d.created_at ? ` · added ${timeAgo(d.created_at)}` : ''}
                    </p>
                  </div>
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] px-2 py-1 rounded shrink-0"
                    style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}
                  >
                    Open ↗
                  </a>
                  <button
                    onClick={() => deleteProductionDoc(d.id)}
                    className="text-[11px] px-2 py-1 rounded shrink-0"
                    style={{ background: 'rgba(239,68,68,0.10)', color: '#ef4444' }}
                  >
                    Detach
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Voiceover — owner attaches the narration the editor should cut to.
          Two add paths (upload audio file / pick from workspace library);
          narrator-approved voiceovers already land on this project via
          /api/narrator/.../approve-full and show up in the list automatically
          because both writers go through the same media_assets row. Files
          live in the R2 narration bucket; library picks reuse the same key
          so the audio isn't duplicated. */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Voiceover</h3>
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Attach the narration the editor should cut to. Upload an audio file (MP3 / WAV / M4A / AAC / OGG / FLAC), or pick from your workspace library. Narrator-approved voiceovers appear here automatically.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          {/* Upload */}
          <div>
            <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>Upload audio</p>
            <input
              ref={voiceoverInputRef}
              type="file"
              accept={VOICEOVER_ACCEPT}
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadVoiceover(f); if (e.target) e.target.value = ''; }}
            />
            <button
              onClick={() => voiceoverInputRef.current?.click()}
              disabled={uploadingVoiceover}
              className="w-full px-3 py-2 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
              style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed', border: '1px solid rgba(124,58,237,0.25)' }}
            >
              {uploadingVoiceover ? 'Uploading…' : '🎙️ Upload'}
            </button>
          </div>

          {/* Library */}
          <div>
            <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>Pick from library</p>
            <button
              onClick={openVoiceoverLibrary}
              className="w-full px-3 py-2 rounded-lg text-xs font-medium cursor-pointer"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Reuse a voiceover attached to another project in this workspace"
            >
              📚 Browse library
            </button>
          </div>
        </div>

        {voiceovers.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No voiceover attached yet</p>
        ) : (
          <div className="space-y-2">
            {voiceovers.map(v => {
              const meta = (v.metadata || {}) as { linked_from_asset_id?: string; full_narration?: boolean };
              const isLinked = !!meta.linked_from_asset_id;
              const fromNarrator = !!meta.full_narration;
              return (
                <div
                  key={v.id}
                  className="p-2.5 rounded-lg"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-base">🎙️</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{v.name}</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {fromNarrator ? 'Narrator-approved' : (isLinked ? 'Linked from library' : (v.r2_key ? 'Uploaded file' : 'External URL'))}
                        {v.size_bytes ? ` · ${(v.size_bytes / 1024 / 1024).toFixed(1)} MB` : ''}
                        {v.duration_seconds ? ` · ${Math.round(v.duration_seconds)}s` : ''}
                        {v.created_at ? ` · added ${timeAgo(v.created_at)}` : ''}
                      </p>
                    </div>
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] px-2 py-1 rounded shrink-0"
                      style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}
                    >
                      Open ↗
                    </a>
                    <button
                      onClick={() => deleteVoiceover(v.id)}
                      className="text-[11px] px-2 py-1 rounded shrink-0"
                      style={{ background: 'rgba(239,68,68,0.10)', color: '#ef4444' }}
                    >
                      Detach
                    </button>
                  </div>
                  {v.url && (
                    <audio
                      controls
                      preload="none"
                      src={v.url}
                      className="w-full mt-2"
                      style={{ height: 32 }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Editor's finished video — owner uploads a video they received from
          the editor (e.g. via Upwork) so it shows up on the editor's
          dashboard and the owner can leave timestamped comments through
          /reviews/[id] just like an editor-direct upload. Same compress →
          presign → R2 PUT → confirm pipeline as the editor's own dashboard
          (shared via @/lib/upload-video-client) so cancel + timeouts +
          stall detection all work the same way. */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Editor&apos;s finished video
          </h3>
          {editorReviewProjectId && editorUploads.length > 0 && (
            <a
              href={`/reviews/${editorReviewProjectId}`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] px-2.5 py-1 rounded-full font-medium"
              style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}
              title="Watch the latest version + leave timestamped comments"
            >
              Open review ↗
            </a>
          )}
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Drop a finished video the editor sent you (e.g. an Upwork delivery). It lands as a new version on the editor&apos;s dashboard and you can leave timestamped comments from <span style={{ color: 'var(--text-secondary)' }}>Open review</span>.
        </p>

        {(() => {
          const eligible = assignments.filter(a => a.status !== 'completed');
          if (eligible.length === 0) {
            return (
              <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
                Assign an editor first — uploads attach to their active assignment so it appears on their dashboard.
              </p>
            );
          }
          if (eligible.length > 1) {
            return (
              <p className="text-xs text-center py-6" style={{ color: '#f59e0b' }}>
                This project has multiple active editors. Complete or revoke the unused assignments before uploading so the file is attributed to the right person.
              </p>
            );
          }
          return null;
        })() ?? (
          <>
            <textarea
              value={editorUploadNote}
              onChange={e => setEditorUploadNote(e.target.value)}
              placeholder="Optional note to the editor (e.g. 'Final cut from Upwork delivery, May 9')"
              className="w-full px-3 py-2 rounded-lg text-sm mb-3 resize-none"
              rows={2}
              disabled={!!editorUploadingForId}
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />

            {editorUploadingForId && editorUploadProgress ? (
              <div>
                {editorUploadProgress.phase === 'compressing' && (
                  <>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                      <div className="h-full transition-all"
                        style={{
                          width: `${Math.round(editorUploadProgress.compressFraction * 100)}%`,
                          background: 'linear-gradient(90deg, #f59e0b, #ef4444)',
                        }} />
                    </div>
                    <p className="text-xs mt-1 text-center" style={{ color: 'var(--text-muted)' }}>
                      Compressing in your browser… {Math.round(editorUploadProgress.compressFraction * 100)}%
                    </p>
                  </>
                )}
                {(editorUploadProgress.phase === 'probing' || editorUploadProgress.phase === 'reserving') && (
                  <p className="text-xs text-center py-2" style={{ color: 'var(--text-muted)' }}>
                    Preparing upload…
                  </p>
                )}
                {editorUploadProgress.phase === 'uploading' && (
                  <>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                      <div className="h-full transition-all"
                        style={{
                          width: `${editorUploadProgress.uploadPercent}%`,
                          background: 'linear-gradient(90deg, #7c3aed, #06b6d4)',
                        }} />
                    </div>
                    <p className="text-xs mt-1 text-center" style={{ color: 'var(--text-muted)' }}>
                      Uploading… {editorUploadProgress.uploadPercent}%
                      {editorUploadProgress.compressionSavedPct != null && (
                        <span className="ml-2" style={{ color: '#22c55e' }}>
                          (saved {editorUploadProgress.compressionSavedPct}% via browser compression)
                        </span>
                      )}
                    </p>
                  </>
                )}
                {editorUploadProgress.phase === 'confirming' && (
                  <p className="text-xs text-center py-2" style={{ color: 'var(--text-muted)' }}>
                    Finishing up…
                  </p>
                )}
                <div className="flex justify-end mt-2">
                  <button
                    onClick={cancelEditorUpload}
                    className="text-[11px] px-3 py-1 rounded cursor-pointer"
                    style={{ background: 'rgba(239,68,68,0.10)', color: '#ef4444' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label className="flex items-center justify-center gap-2 p-4 rounded-lg border-2 border-dashed cursor-pointer transition-colors hover:border-purple-500/50"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                  <input type="file" accept="video/*" className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) startEditorUpload(f);
                      if (e.target) e.target.value = '';
                    }}
                  />
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span className="text-sm">Click to choose the video the editor sent you</span>
                </label>
                <label className="flex items-center gap-2 mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    checked={editorEnableCompression}
                    onChange={e => setEditorEnableCompression(e.target.checked)}
                  />
                  <span>Auto-compress before upload (faster, smaller — runs in your browser)</span>
                </label>
              </>
            )}

            {editorUploads.length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
                  Uploaded versions
                </p>
                {editorUploads.map(v => {
                  const sizeMB = v.file_size != null ? (v.file_size / 1024 / 1024).toFixed(1) : null;
                  return (
                    <div key={v.id} className="p-2 rounded-lg flex items-center gap-3"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
                      {v.thumbnail_url ? (
                        <img src={v.thumbnail_url} alt="" className="w-16 h-9 object-cover rounded shrink-0" />
                      ) : (
                        <div className="w-16 h-9 rounded flex items-center justify-center shrink-0"
                          style={{ background: 'var(--bg-secondary)' }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                            style={{ color: 'var(--text-muted)' }}>
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                          v{v.version_number}
                          {v.uploaded_by && (
                            <span className="ml-2 text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>
                              · {v.uploaded_by}
                            </span>
                          )}
                        </p>
                        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {new Date(v.created_at).toLocaleDateString()}
                          {sizeMB ? ` · ${sizeMB} MB` : ''}
                        </p>
                      </div>
                      {v.unresolved_comment_count > 0 && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                          style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                          💬 {v.unresolved_comment_count} unresolved
                        </span>
                      )}
                      <a
                        href={`/reviews/${v.review_project_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] px-2 py-1 rounded shrink-0"
                        style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}
                      >
                        Review ↗
                      </a>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Production-doc library modal — workspace-scoped picker. Click "Attach"
          to insert a new media_assets row on this project pointing at the
          same R2 file (or external URL), so the file isn't duplicated. */}
      {showProdDocLibrary && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setShowProdDocLibrary(false)}
        >
          <div
            className="rounded-2xl w-[min(720px,92vw)] max-h-[85vh] flex flex-col"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
              <div>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Production doc library</h3>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Pick an existing doc from another project to attach here.
                </p>
              </div>
              <button
                onClick={() => setShowProdDocLibrary(false)}
                className="text-xs px-2 py-1 rounded"
                style={{ color: 'var(--text-muted)' }}
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {prodDocLibLoading && (
                <div className="flex items-center justify-center py-12">
                  <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin"
                    style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
                </div>
              )}
              {!prodDocLibLoading && prodDocLibError && (
                <p className="text-xs text-center py-8" style={{ color: '#ef4444' }}>{prodDocLibError}</p>
              )}
              {!prodDocLibLoading && !prodDocLibError && prodDocLibrary.length === 0 && (
                <p className="text-xs text-center py-12" style={{ color: 'var(--text-muted)' }}>
                  No production docs in your workspace yet.
                </p>
              )}
              {!prodDocLibLoading && !prodDocLibError && prodDocLibrary.length > 0 && (
                <div className="space-y-2">
                  {prodDocLibrary.map(item => {
                    const itemMeta = (item.metadata || {}) as { source_kind?: string };
                    const isSheet = itemMeta.source_kind === 'google_sheet';
                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 p-2.5 rounded-lg"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
                      >
                        <span className="text-base">{isSheet ? '📊' : '📄'}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{item.name}</p>
                          <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                            {item.project_title || '—'}
                            {item.size_bytes ? ` · ${(item.size_bytes / 1024 / 1024).toFixed(1)} MB` : ''}
                            {isSheet ? ' · Google Sheet' : ''}
                          </p>
                        </div>
                        {item.url && (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[10px] px-2 py-1 rounded shrink-0"
                            style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
                          >
                            Preview ↗
                          </a>
                        )}
                        <button
                          onClick={() => attachExistingProductionDoc(item)}
                          disabled={attachingProdDoc === item.id}
                          className="text-[11px] px-2.5 py-1 rounded shrink-0 cursor-pointer disabled:opacity-50"
                          style={{ background: '#7c3aed', color: 'white' }}
                        >
                          {attachingProdDoc === item.id ? 'Attaching…' : 'Attach'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Voiceover library modal — workspace-scoped picker. Same attach
          semantics as production docs: insert a new media_assets row on this
          project that points at the same R2 key, so the audio file isn't
          duplicated and a single narrator-approved voiceover can be reused
          across multiple videos. */}
      {showVoiceoverLibrary && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setShowVoiceoverLibrary(false)}
        >
          <div
            className="rounded-2xl w-[min(720px,92vw)] max-h-[85vh] flex flex-col"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
              <div>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Voiceover library</h3>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Pick a voiceover from another project to attach here.
                </p>
              </div>
              <button
                onClick={() => setShowVoiceoverLibrary(false)}
                className="text-xs px-2 py-1 rounded"
                style={{ color: 'var(--text-muted)' }}
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {voiceoverLibLoading && (
                <div className="flex items-center justify-center py-12">
                  <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin"
                    style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
                </div>
              )}
              {!voiceoverLibLoading && voiceoverLibError && (
                <p className="text-xs text-center py-8" style={{ color: '#ef4444' }}>{voiceoverLibError}</p>
              )}
              {!voiceoverLibLoading && !voiceoverLibError && voiceoverLibrary.length === 0 && (
                <p className="text-xs text-center py-12" style={{ color: 'var(--text-muted)' }}>
                  No voiceovers in your workspace yet.
                </p>
              )}
              {!voiceoverLibLoading && !voiceoverLibError && voiceoverLibrary.length > 0 && (
                <div className="space-y-2">
                  {voiceoverLibrary.map(item => {
                    const itemMeta = (item.metadata || {}) as { full_narration?: boolean };
                    const fromNarrator = !!itemMeta.full_narration;
                    return (
                      <div
                        key={item.id}
                        className="p-2.5 rounded-lg"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-base">🎙️</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{item.name}</p>
                            <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                              {item.project_title || '—'}
                              {item.size_bytes ? ` · ${(item.size_bytes / 1024 / 1024).toFixed(1)} MB` : ''}
                              {item.duration_seconds ? ` · ${Math.round(item.duration_seconds)}s` : ''}
                              {fromNarrator ? ' · Narrator-approved' : ''}
                            </p>
                          </div>
                          <button
                            onClick={() => attachExistingVoiceover(item)}
                            disabled={attachingVoiceover === item.id}
                            className="text-[11px] px-2.5 py-1 rounded shrink-0 cursor-pointer disabled:opacity-50"
                            style={{ background: '#7c3aed', color: 'white' }}
                          >
                            {attachingVoiceover === item.id ? 'Attaching…' : 'Attach'}
                          </button>
                        </div>
                        {item.url && (
                          <audio
                            controls
                            preload="none"
                            src={item.url}
                            className="w-full mt-2"
                            style={{ height: 32 }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
