import sharp from 'sharp';
import { createHash } from 'node:crypto';

export class ImageInputError extends Error {}

export function imageReferences(item) {
  return [
    ...(item.payload?.images ?? []).map((image, index) => ({ image, index, label: `根评论图片 ${index + 1}` })),
    ...(item.payload?.comments ?? []).flatMap(comment => (comment.images ?? []).map((image, index) => ({ image, index, commentId: comment.id, label: `楼中楼 ${comment.id} 图片 ${index + 1}` }))),
  ];
}

export async function escalationImages(ctx, service, { item, provider, model, signal }) {
  const refs = imageReferences(item);
  if (refs.length > 20) throw new ImageInputError('本楼超过20张图片，未省略图片作判断，请人工查看。');
  const route = await ctx.llm.resolveModelInfo(provider, model, signal);
  signal?.throwIfAborted();
  if (!route.inputModalities?.includes('image')) throw new ImageInputError('决策升级模型未声明支持图片，请在生成／分析模型中选择支持图片的模型后重试。');
  const attachments = ctx.get?.('attachments');
  if (!attachments?.saveImages) throw new ImageInputError('宿主图片附件服务不可用，未执行含图决策升级。');
  const inputs = [], manifest = []; let bytes = 0;
  for (const ref of refs) {
    signal?.throwIfAborted();
    let body;
    try {
      const original = await service.image(item.id, { version: item.version, index: ref.index, ...(ref.commentId == null ? {} : { commentId: ref.commentId }), variant: 'original' });
      body = await sharp(original.body, { limitInputPixels: 40e6 }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    } catch (error) {
      signal?.throwIfAborted();
      throw new ImageInputError(`${ref.label}未能装入模型：${error.message}`);
    }
    bytes += body.length;
    if (bytes > 10 * 1048576) throw new ImageInputError('升级图片输入合计超过10MiB，未省略图片作判断，请人工查看。');
    inputs.push({ data: body, mediaType: 'image/jpeg', name: `${ref.label}.jpg` });
    manifest.push({ label: ref.label, ...(ref.commentId == null ? {} : { commentId: ref.commentId }), index: ref.index, url: ref.image.url, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length });
  }
  signal?.throwIfAborted();
  let saved;
  try { saved = await attachments.saveImages(inputs); }
  catch (error) { signal?.throwIfAborted(); throw new ImageInputError(`宿主未能接收升级图片：${error.message}`); }
  return { blocks: saved.flatMap((attachment, index) => [{ type: 'text', text: manifest[index].label }, { type: 'image', attachment }]), manifest: manifest.map((entry, index) => ({ ...entry, attachment: saved[index] })) };
}
