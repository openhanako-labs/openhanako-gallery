/**
 * tagger.js
 * 标签 CRUD 操作
 *
 * 基于 images/tags/image_tags 三张表的多对多标签系统。
 * 所有函数均依赖已初始化的数据库（通过 getDb() 获取）。
 */

import { queryOne, queryAll, runSql, flush } from './db.js';

/** 获取或创建标签，返回 tag id */
function getOrCreateTag(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;

  let tag = queryOne('SELECT id FROM tags WHERE name = ?', [trimmed]);
  if (tag) return tag.id;

  runSql('INSERT INTO tags (name) VALUES (?)', [trimmed]);
  tag = queryOne('SELECT id FROM tags WHERE name = ?', [trimmed]);
  return tag?.id || null;
}

/** 为图片添加标签（支持批量） */
export function addTags(imageIds, tagNames) {
  if (!Array.isArray(imageIds)) imageIds = [imageIds];
  if (!Array.isArray(tagNames)) tagNames = [tagNames];

  for (const imgId of imageIds) {
    for (const name of tagNames) {
      const tagId = getOrCreateTag(name);
      if (!tagId) continue;
      // 忽略已存在的关联（INSERT OR IGNORE）
      try {
        runSql('INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)', [imgId, tagId]);
      } catch (e) {
        // sql.js 的 INSERT OR IGNORE 可能报错，静默跳过
      }
    }
  }
  flush();
}

/** 从图片移除标签（支持批量） */
export function removeTags(imageIds, tagNames) {
  if (!Array.isArray(imageIds)) imageIds = [imageIds];
  if (!Array.isArray(tagNames)) tagNames = [tagNames];

  for (const imgId of imageIds) {
    for (const name of tagNames) {
      const tag = queryOne('SELECT id FROM tags WHERE name = ?', [name]);
      if (!tag) continue;
      runSql('DELETE FROM image_tags WHERE image_id = ? AND tag_id = ?', [imgId, tag.id]);
    }
  }
  flush();
}

/** 获取图片的所有标签 */
export function getImageTags(imageId) {
  const rows = queryAll(`
    SELECT t.name FROM tags t
    JOIN image_tags it ON t.id = it.tag_id
    WHERE it.image_id = ?
    ORDER BY t.name
  `, [imageId]);
  return rows.map(r => r.name);
}

/** 搜索包含指定标签的图片 */
export function findImagesByTags(tagNames, matchAll = false) {
  if (!Array.isArray(tagNames)) tagNames = [tagNames];
  if (tagNames.length === 0) return [];

  if (matchAll) {
    // 必须包含所有标签
    const placeholders = tagNames.map(() => '?').join(',');
    return queryAll(`
      SELECT it.image_id FROM image_tags it
      JOIN tags t ON t.id = it.tag_id
      WHERE t.name IN (${placeholders})
      GROUP BY it.image_id
      HAVING COUNT(DISTINCT t.name) = ?
    `, [...tagNames, tagNames.length]);
  } else {
    // 包含任一标签
    const placeholders = tagNames.map(() => '?').join(',');
    const rows = queryAll(`
      SELECT DISTINCT it.image_id FROM image_tags it
      JOIN tags t ON t.id = it.tag_id
      WHERE t.name IN (${placeholders})
    `, tagNames);
    return rows;
  }
}

/** 列出所有标签（可附带图片数量） */
export function listTags(includeCount = false) {
  if (includeCount) {
    return queryAll(`
      SELECT t.id, t.name, COUNT(it.image_id) as image_count
      FROM tags t
      LEFT JOIN image_tags it ON t.id = it.tag_id
      GROUP BY t.id
      ORDER BY t.name
    `);
  }
  return queryAll('SELECT id, name FROM tags ORDER BY name');
}

/** 重命名标签 */
export function renameTag(oldName, newName) {
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, error: '新标签名不能为空' };

  // 如果新名称已存在，合并
  const existing = queryOne('SELECT id FROM tags WHERE name = ?', [trimmed]);
  const old = queryOne('SELECT id FROM tags WHERE name = ?', [oldName]);
  if (!old) return { ok: false, error: `标签 "${oldName}" 不存在` };

  if (existing && existing.id !== old.id) {
    // 合并：将旧标签的关联转移到新标签
    runSql(`UPDATE OR IGNORE image_tags SET tag_id = ? WHERE tag_id = ?`, [existing.id, old.id]);
    runSql('DELETE FROM image_tags WHERE tag_id = ?', [old.id]);
    runSql('DELETE FROM tags WHERE id = ?', [old.id]);
  } else if (!existing) {
    runSql('UPDATE tags SET name = ? WHERE id = ?', [trimmed, old.id]);
  }
  flush();
  return { ok: true };
}

/** 删除标签（同时删除所有关联） */
export function deleteTag(name) {
  const tag = queryOne('SELECT id FROM tags WHERE name = ?', [name]);
  if (!tag) return { ok: false, error: `标签 "${name}" 不存在` };

  runSql('DELETE FROM image_tags WHERE tag_id = ?', [tag.id]);
  runSql('DELETE FROM tags WHERE id = ?', [tag.id]);
  flush();
  return { ok: true };
}