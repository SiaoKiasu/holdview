import { authorizeAccount, authenticatedJson, checkOrigin } from "@/lib/auth";
import { dashboard } from "@/lib/service";
import { failure } from "@/lib/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const auth = await authorizeAccount(request);
    checkOrigin(request);
    return authenticatedJson(await dashboard(auth.config, true, true), auth);
  } catch (e) {
    return failure(e);
  }
}
