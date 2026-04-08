'use strict';

/**
 * 解析 markdown 内容，将表格块转换为飞书原生 table 元素
 * 飞书卡片的 tag:'markdown' 不支持渲染 markdown 表格，需要转换
 * @param {string} content
 * @returns {Array} 飞书卡片元素数组
 */
function parseMarkdownToElements(content) {
    if (!content) return [];

    const lines = content.split('\n');
    const elements = [];
    const textLines = [];
    let i = 0;

    const flushText = () => {
        const text = textLines.splice(0).join('\n').trimEnd();
        if (text) elements.push({ tag: 'markdown', content: text });
    };

    while (i < lines.length) {
        const line = lines[i];
        const nextLine = i + 1 < lines.length ? lines[i + 1] : '';

        // 识别 markdown 表格：当前行含 |...|，下一行是分隔符 |---|
        if (/^\s*\|/.test(line) && /^\s*\|[\s\-:|]+\|/.test(nextLine)) {
            flushText();

            // 收集连续的表格行
            const tableLines = [];
            while (i < lines.length && /^\s*\|/.test(lines[i])) {
                tableLines.push(lines[i]);
                i++;
            }

            const tableEl = buildFeishuTable(tableLines);
            if (tableEl) {
                elements.push(tableEl);
            } else {
                // 解析失败时退化为代码块
                elements.push({ tag: 'markdown', content: '```\n' + tableLines.join('\n') + '\n```' });
            }
            continue;
        }

        textLines.push(line);
        i++;
    }

    flushText();
    return elements.length > 0 ? elements : [{ tag: 'markdown', content: content }];
}

/**
 * 将 markdown 表格行数组转换为飞书 table 元素
 * @param {string[]} lines - 包含 header、separator、data rows
 * @returns {Object|null}
 */
function buildFeishuTable(lines) {
    if (lines.length < 2) return null;

    const splitRow = (line) => {
        const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return trimmed.split('|').map(c => c.trim());
    };

    const headerCells = splitRow(lines[0]);
    if (!headerCells.length) return null;

    // 验证分隔行
    if (!/^[\s|:\-]+$/.test(lines[1])) return null;

    const dataRows = lines.slice(2)
        .filter(l => l.trim())
        .map(l => splitRow(l));

    if (dataRows.length === 0) return null;

    const columns = headerCells.map((header, idx) => ({
        name: `c${idx}`,
        display_name: header || `列${idx + 1}`,
        width: 'auto',
    }));

    const rows = dataRows.map(cells => {
        const row = {};
        headerCells.forEach((_, idx) => {
            row[`c${idx}`] = cells[idx] ?? '';
        });
        return row;
    });

    return {
        tag: 'table',
        page_size: rows.length,
        row_height: 'low',
        header_style: {
            text_align: 'left',
            text_size: 'normal',
            background_style: 'grey',
            text_color: 'default',
            bold: true,
            lines: 1,
        },
        columns,
        rows,
    };
}

/**
 * 构建多选卡片（输入框方案：用户输入选项编号，一次提交）
 * @param {Object} notification - sessionState 里的通知对象，含 _ms_options/_question/_context_text/_note_parts
 * @param {string} stateKey - session_state_key
 * @returns {Object} 飞书卡片 JSON
 */
function buildMultiSelectCard(notification, stateKey) {
    const options = notification._ms_options || [];
    const question = notification._question || '';
    const contextText = notification._context_text || '';
    const noteParts = notification._note_parts || '';

    const elements = [];

    if (contextText) {
        elements.push(...parseMarkdownToElements(contextText));
        elements.push({ tag: 'hr' });
    }

    // 问题 + 编号列表（含 Other）
    const optList = options.map((opt, i) => `**${i + 1}.** ${opt}`).join('\n');
    const otherNum = options.length + 1;
    elements.push({ tag: 'markdown', content: `${question}\n\n${optList}\n**${otherNum}.** Other（自定义文本）\n\n输入编号（空格分隔），选 Other 加冒号写文本：\n如 \`1 3\` 或 \`1 ${otherNum}:我的文本\`` });

    // 输入框
    elements.push({ tag: 'action', actions: [{
        tag: 'input',
        name: 'multi_select_input',
        placeholder: { tag: 'plain_text', content: `如 1 3 或 1 ${otherNum}:自定义文本` },
        width: 'fill',
        value: { action_type: 'submit_multi', session_state_key: stateKey },
    }]});

    if (noteParts) elements.push({ tag: 'markdown', content: noteParts });

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '📋 多选' },
            template: 'orange',
        },
        elements,
    };
}

module.exports = { parseMarkdownToElements, buildFeishuTable, buildMultiSelectCard };
