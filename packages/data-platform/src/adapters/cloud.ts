// © Infinitum Corporation®. All rights reserved.
/**
 * Cumulus://Cloud adapter: turns Drive storage hooks into collection events. The Drive
 * server calls these after each operation commits; file content and names never leave the
 * Drive, only metadata the file.* contracts allow.
 */
import type { Collector } from "../sdk.ts";
import { deterministicEventId } from "../gateway.ts";

export interface DriveFileMeta {
  tenant_id: string;
  file_id: string;
  owner_cid: string;
  size_bytes: number;
  media_type: string;
  version: number;
  folder_id?: string;
  sha256?: string;
}

export class CloudDriveAdapter {
  private readonly c: Collector;
  constructor(collector: Collector) {
    this.c = collector;
  }

  /** Event ids derive from (file, version, action) so a re-fired hook is stored once. */
  uploaded(f: DriveFileMeta, at?: string): string {
    return this.c.track({
      event_id: deterministicEventId("cloud", f.tenant_id, f.file_id, String(f.version), f.version === 1 ? "uploaded" : "version"),
      event_type: f.version === 1 ? "file.uploaded" : "file.version_added",
      tenant_id: f.tenant_id,
      subject_cid: f.owner_cid,
      object_id: f.file_id,
      purpose: "service_operation",
      ...(at ? { occurred_at: at } : {}),
      payload:
        f.version === 1
          ? {
              size_bytes: f.size_bytes,
              media_type: f.media_type,
              version: 1,
              ...(f.folder_id ? { folder_id: f.folder_id } : {}),
              ...(f.sha256 ? { sha256: f.sha256 } : {}),
            }
          : { size_bytes: f.size_bytes, version: f.version },
    });
  }

  shared(tenantId: string, fileId: string, ownerCid: string, granteeCid: string, role: "viewer" | "editor", at?: string): string {
    return this.c.track({
      event_type: "file.shared",
      tenant_id: tenantId,
      subject_cid: ownerCid,
      object_id: fileId,
      purpose: "service_operation",
      payload: { grantee_cid: granteeCid, role },
      ...(at ? { occurred_at: at } : {}),
    });
  }

  unshared(tenantId: string, fileId: string, ownerCid: string, granteeCid: string, at?: string): string {
    return this.c.track({
      event_type: "file.unshared",
      tenant_id: tenantId,
      subject_cid: ownerCid,
      object_id: fileId,
      purpose: "service_operation",
      payload: { grantee_cid: granteeCid },
      ...(at ? { occurred_at: at } : {}),
    });
  }

  deleted(tenantId: string, fileId: string, ownerCid: string, at?: string): string {
    return this.c.track({
      event_id: deterministicEventId("cloud", tenantId, fileId, "deleted"),
      event_type: "file.deleted",
      tenant_id: tenantId,
      subject_cid: ownerCid,
      object_id: fileId,
      purpose: "service_operation",
      payload: {},
      ...(at ? { occurred_at: at } : {}),
    });
  }
}
