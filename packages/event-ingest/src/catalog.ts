/** Generic catalog provenance; informed by public satellite SDK metadata/data-license separation.
 * No imagery discovery/download, spatial search, orbit calculation or operational tasking.
 */
import {archiveEvent,exact,fail,identifier,object} from "./schema.ts";
export function catalogManifestEvent(id:string,value:unknown) {
  const row=object(value);exact(row,["provider","dataset","assetSha256","license","attribution"]);
  const provider=identifier(row.provider),dataset=identifier(row.dataset);
  if(typeof row.assetSha256!=="string"||!/^[a-f0-9]{64}$/.test(row.assetSha256))return fail("invalid","Asset checksum required");
  if(typeof row.license!=="string"||!/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(row.license)||row.license==="UNKNOWN")return fail("invalid","Explicit license identifier required");
  if(typeof row.attribution!=="string"||!row.attribution.trim()||row.attribution.length>1024)return fail("invalid","Explicit attribution required");
  return archiveEvent({id,kind:"archive",payload:{format:"licensed-catalog-manifest-v1",provider,dataset,assetSha256:row.assetSha256,license:row.license,attribution:row.attribution}});
}
