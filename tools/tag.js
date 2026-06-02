/**
 * tag.js
 * 标签管理工具
 *
 * 支持操作：add（添加标签）、remove（移除标签）、list（列出标签，可含图片数）、
 *          search（搜索带标签的图片）、rename（重命名/合并）、delete（删除标签）
 */

const name = 'gallery_tag';
const description = `图片标签管理。支持添加、移除、列表、搜索、重命名、删除标签。`;

const parameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: ['add', 'remove', 'list', 'search', 'rename', 'delete'],
      default: 'list'
    },
    image_ids: {
      type: 'array',
      items: { type: 'string' },
      description: '图片 ID 列表（add/remove/search 时必填）'
    },
    tag: {
      type: 'string',
      description: '标签名（add/remove/search/rename/delete 时使用）'
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '多个标签（add/remove 时使用）'
    },
    new_name: {
      type: 'string',
      description: '新标签名（rename 时必填）'
    },
    match_all: {
      type: 'boolean',
      description: 'search 模式：true=包含所有标签，false=任一标签',
      default: false
    },
    include_count: {
      type: 'boolean',
      description: 'list 模式：是否包含图片数量统计',
      default: false
    }
  },
  required: ['action']
};

async function execute(input, ctx) {
  const { initDb } = await import('../lib/db.js');
  await initDb(ctx);

  const {
    addTags, removeTags, getImageTags,
    listTags, findImagesByTags,
    renameTag, deleteTag
  } = await import('../lib/tagger.js');

  switch (input.action) {
    case 'add': {
      const imageIds = input.image_ids || [];
      const tagNames = input.tags || (input.tag ? [input.tag] : []);
      if (imageIds.length === 0 || tagNames.length === 0) {
        return JSON.stringify({ status: 'error', message: '缺少 image_ids 或 tag/tags' }, null, 2);
      }
      addTags(imageIds, tagNames);
      return JSON.stringify({
        status: 'ok',
        action: 'add',
        image_ids: imageIds,
        tags: tagNames
      }, null, 2);
    }

    case 'remove': {
      const imageIds = input.image_ids || [];
      const tagNames = input.tags || (input.tag ? [input.tag] : []);
      if (imageIds.length === 0 || tagNames.length === 0) {
        return JSON.stringify({ status: 'error', message: '缺少 image_ids 或 tag/tags' }, null, 2);
      }
      removeTags(imageIds, tagNames);
      return JSON.stringify({
        status: 'ok',
        action: 'remove',
        image_ids: imageIds,
        tags: tagNames
      }, null, 2);
    }

    case 'list': {
      const tags = listTags(input.include_count);
      return JSON.stringify({
        status: 'ok',
        action: 'list',
        count: tags.length,
        tags
      }, null, 2);
    }

    case 'search': {
      const tagNames = input.tags || (input.tag ? [input.tag] : []);
      if (tagNames.length === 0) {
        return JSON.stringify({ status: 'error', message: '缺少 tag/tags' }, null, 2);
      }
      const imageIds = findImagesByTags(tagNames, input.match_all);
      // 获取图片信息
      const { queryAll } = await import('../lib/db.js');
      const images = imageIds.length > 0
        ? queryAll(`SELECT id, filename, path, ext, date_taken FROM images WHERE id IN (${imageIds.map(() => '?').join(',')}) ORDER BY date_taken DESC`, imageIds)
        : [];
      return JSON.stringify({
        status: 'ok',
        action: 'search',
        tag: input.tag || input.tags,
        match_all: input.match_all || false,
        count: images.length,
        images
      }, null, 2);
    }

    case 'rename': {
      if (!input.tag || !input.new_name) {
        return JSON.stringify({ status: 'error', message: '缺少 tag 或 new_name' }, null, 2);
      }
      const result = renameTag(input.tag, input.new_name);
      return JSON.stringify({ status: result.ok ? 'ok' : 'error', ...result }, null, 2);
    }

    case 'delete': {
      if (!input.tag) {
        return JSON.stringify({ status: 'error', message: '缺少 tag' }, null, 2);
      }
      const result = deleteTag(input.tag);
      return JSON.stringify({ status: result.ok ? 'ok' : 'error', ...result }, null, 2);
    }

    default:
      return JSON.stringify({ status: 'error', message: `未知操作: ${input.action}` }, null, 2);
  }
}

export { name, description, parameters, execute };