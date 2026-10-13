import { authorizeAdmin, authenticatedJson, checkOrigin } from "@/lib/auth";
import { readFuturesSettings, writeFuturesSettings } from "@/lib/futures-store";
import { futuresWriteSchema } from "@/lib/futures-schema";
import { failure } from "@/lib/http";
import { AppError } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const auth = await authorizeAdmin(request);
    return authenticatedJson(
      {
        ...(await readFuturesSettings(auth.config)),
        writable:
          auth.config.DATA_SOURCE !== "demo" &&
          (!process.env.VERCEL || Boolean(auth.config.DATABASE_URL)),
      },
      auth,
    );
  } catch (e) {
    return failure(e);
  }
}
export async function PUT(request: Request) {
  try {
    const auth = await authorizeAdmin(request);
    checkOrigin(request);
    if (auth.config.DATA_SOURCE === "demo")
      throw new AppError("INVALID_ACCOUNT", "演示账户不支持合约接入，请选择真实账户。", 400);
    if (Number(request.headers.get("content-length") ?? 0) > 50000)
      throw new AppError("INVALID_BODY", "合约配置过大。", 400);
    const raw = await request.text();
    if (raw.length > 50000) throw new AppError("INVALID_BODY", "合约配置过大。", 400);
    let body;
    try {
      body = futuresWriteSchema.parse(JSON.parse(raw));
    } catch {
      throw new AppError(
        "INVALID_BODY",
        "请填写有效的累计净划入金额，最多 20 位整数、16 位小数；留空可停用合约汇总。",
        400,
      );
    }
    return authenticatedJson(
      await writeFuturesSettings(auth.config, body.netTransfer, body.revision, auth.user.username),
      auth,
    );
  } catch (e) {
    return failure(e);
  }
}
