"""AO3 读后感 - 后端 API
使用 ao3_api 库获取 AO3 作品信息，前端调用此 API 即可绕过 CORS 限制。
部署于 Render.com 免费 tier。
"""

import re
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS
import AO3

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def extract_work_id(url):
    """从 AO3 URL 中提取数字 work ID"""
    match = re.search(r'/works/(\d+)', url)
    return int(match.group(1)) if match else None


def safe_get(obj, *attr_names):
    """依次尝试多个属性名，返回第一个存在的值，否则返回默认值"""
    for name in attr_names:
        val = getattr(obj, name, None)
        if val is not None and val != '' and val != []:
            return val
    return None


def build_work_data(work, ao3_url):
    """从 AO3.Work 对象提取所有字段，返回字典"""
    # 基本字段
    title = str(safe_get(work, 'title') or '')

    # 作者 - 可能是字符串、列表，或需要从 authors 列表取第一个
    author_raw = safe_get(work, 'author', 'authors')
    if isinstance(author_raw, list):
        author = author_raw[0] if author_raw else ''
    else:
        author = str(author_raw) if author_raw else ''

    # 同人圈
    fandom_raw = safe_get(work, 'fandoms', 'fandom') or []
    if isinstance(fandom_raw, str):
        fandom = [fandom_raw]
    else:
        fandom = [str(f) for f in fandom_raw]

    # 关系 / CP
    rel_raw = safe_get(work, 'relationships', 'relationship', 'relationships_list') or []
    if isinstance(rel_raw, str):
        relationships = [rel_raw]
    else:
        relationships = [str(r) for r in rel_raw]

    # 角色
    char_raw = safe_get(work, 'characters', 'character') or []
    if isinstance(char_raw, str):
        characters = [char_raw]
    else:
        characters = [str(c) for c in char_raw]

    # 自由标签
    tags_raw = safe_get(work, 'tags', 'freeform_tags', 'additional_tags', 'freeformtags') or []
    if isinstance(tags_raw, str):
        freeform_tags = [tags_raw]
    else:
        freeform_tags = [str(t) for t in tags_raw]

    # 评级
    rating_raw = safe_get(work, 'rating')
    if isinstance(rating_raw, list):
        rating = rating_raw[0] if rating_raw else ''
    else:
        rating = str(rating_raw) if rating_raw else ''

    # 警告
    warn_raw = safe_get(work, 'warnings', 'warning') or []
    if isinstance(warn_raw, str):
        warnings = [warn_raw]
    else:
        warnings = [str(w) for w in warn_raw]

    # 类别
    cat_raw = safe_get(work, 'category', 'categories')
    if isinstance(cat_raw, list):
        category = cat_raw[0] if cat_raw else ''
    else:
        category = str(cat_raw) if cat_raw else ''

    # 摘要
    summary = str(safe_get(work, 'summary') or '')

    # 字数
    words_raw = safe_get(work, 'words', 'nwords', 'word_count')
    if words_raw is not None:
        word_count = str(words_raw)
    else:
        word_count = ''

    # 章节
    nchapters = safe_get(work, 'nchapters', 'chapters_count')
    if nchapters is not None:
        chapters = str(nchapters)
    else:
        chapters = ''

    # 完结状态
    complete = safe_get(work, 'complete', 'completed', 'is_complete')
    if complete is not None:
        # 如果 chapters 信息包含 completed / total 格式，尝试判断
        status = 'Completed' if complete else 'In Progress'
    else:
        status = ''

    # 语言
    language = str(safe_get(work, 'language') or '')

    # 发布日期
    published_raw = safe_get(work, 'date_published', 'published', 'date')
    if hasattr(published_raw, 'isoformat'):
        published = published_raw.isoformat()
    else:
        published = str(published_raw) if published_raw else ''

    return {
        'title': title,
        'author': author,
        'fandom': fandom,
        'relationships': relationships,
        'characters': characters,
        'freeformTags': freeform_tags,
        'rating': rating,
        'warnings': warnings,
        'category': category,
        'summary': summary,
        'wordCount': word_count,
        'chapters': chapters,
        'status': status,
        'language': language,
        'published': published,
        'ao3Url': ao3_url,
    }


@app.route('/api/fetch')
def fetch_work():
    """获取 AO3 作品信息
    GET /api/fetch?url=https://archiveofourown.org/works/12345
    """
    url = request.args.get('url', '').strip()
    if not url:
        return jsonify({'ok': False, 'error': '缺少 url 参数'}), 400

    work_id = extract_work_id(url)
    if not work_id:
        return jsonify({'ok': False, 'error': '无法从 URL 提取作品 ID，请检查链接格式'}), 400

    logger.info(f'Fetching work {work_id} from {url}')

    try:
        work = AO3.Work(work_id)
        data = build_work_data(work, url)
        logger.info(f'Success: "{data["title"]}" by {data["author"]}')
        return jsonify({'ok': True, 'data': data})
    except Exception as e:
        logger.error(f'Failed to fetch work {work_id}: {e}')
        return jsonify({'ok': False, 'error': f'获取失败: {str(e)}'}), 500


@app.route('/api/health')
def health():
    """健康检查"""
    return jsonify({'ok': True, 'status': 'running'})


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
