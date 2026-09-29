import "dotenv/config";

// Stato di un post su Zernio (e di TikTok dentro): npx tsx src/dev/zernio-post.ts <postId>
const key = process.env.ZERNIO_API_KEY;
const id = process.argv[2];
if (!key || !id) throw new Error("serve ZERNIO_API_KEY e l'id del post");
const res = await fetch(`https://zernio.com/api/v1/posts/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
const body = (await res.json()) as { post?: { status?: string; platforms?: Record<string, unknown>[] } };
console.log(res.status, body.post?.status);
for (const p of body.post?.platforms ?? []) {
  const { platformSpecificData: _psd, accountId: _acc, ...rest } = p;
  console.log(JSON.stringify(rest, null, 1));
}
