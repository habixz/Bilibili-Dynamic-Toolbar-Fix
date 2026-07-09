// ==UserScript==
// @name         B站动态操作栏固定
// @namespace    https://github.com/habixz
// @version      1.0.0
// @description  固定 B 站动态操作栏，并增强评论关闭前滚动与“回到动态”按钮交互
// @author       habixz
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*/dynamic*
// @match        https://www.bilibili.com/v/topic/detail/*
// @grant        none
// @run-at       document-start
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NAME = 'B站动态操作栏固定';
    const STYLE_ID = 'bili-dynamic-sticky-footer-style';
    const CARD_SELECTOR = '.bili-dyn-item';
    const CARD_ADAPTER = {
        main: ':scope > .bili-dyn-item__main',
        footer: '.bili-dyn-item__footer',
        panel: '.bili-dyn-item__panel',
        commentButton: '.bili-dyn-action.comment'
    };
    const DEFAULT_STICKY_TOP = 64;
    const SCROLL_ALIGN_MARGIN = 8;
    const REFRESH_DELAY = 80;

    const state = {
        mounted: false,
        fullRefreshTimerId: 0,
        cardRefreshFrameId: 0,
        layoutRefreshFrameId: 0,
        viewportStateFrameId: 0,
        bodyObserver: null,
        themeObserver: null,
        historyHooked: false,
        eventsBound: false,
        commentCloseBypassButtons: new WeakSet(),
        pendingObservedCards: new Set(),
        scrollActionButtons: new Set(),
        scrollActionButtonMeta: new WeakMap()
    };

    bootstrap();

    /**
     * 脚本入口。
     * 这里优先接管 SPA 路由切换，再在 DOM 可操作后执行一次正式挂载。
     */
    function bootstrap() {
        hookHistoryMethods();
        window.addEventListener('popstate', scheduleFullRefresh, { passive: true });

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mount, { once: true });
        } else {
            mount();
        }
    }

    /**
     * 只挂载一次，后续增量更新统一由观察器和节流刷新接管。
     */
    function mount() {
        if (state.mounted || !document.body) {
            return;
        }

        ensureStyle();
        bindGlobalEvents();
        startObservers();
        refreshAll();
        state.mounted = true;
    }

    /**
     * 注入操作栏固定所需样式。
     * 颜色不写死，统一通过 CSS 变量承接，便于适配 B 站深浅色主题。
     */
    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            :root {
                --bdsf-surface: rgba(255, 255, 255, 0.96);
                --bdsf-text: #18191c;
                --bdsf-border: rgba(24, 25, 28, 0.10);
                --bdsf-sticky-top: ${DEFAULT_STICKY_TOP}px;
            }
            @media (prefers-color-scheme: dark) {
                :root {
                    --bdsf-surface: rgba(31, 34, 39, 0.94);
                    --bdsf-text: #f1f2f3;
                    --bdsf-border: rgba(255, 255, 255, 0.10);
                }
            }
            .bdsf-sticky-footer {
                position: sticky !important;
                top: var(--bdsf-sticky-top) !important;
                z-index: 5 !important;
                padding: 0 72px 0 88px !important;
                background: var(--bdsf-surface) !important;
                color: var(--bdsf-text) !important;
                border: none !important;
                box-shadow: none !important;
            }
            .bdsf-sticky-footer .bili-dyn-action,
            .bdsf-sticky-footer .bili-dyn-action__icon,
            .bdsf-sticky-footer .bili-dyn-action__text {
                color: inherit !important;
            }
            .bdsf-scroll-action-btn {
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 26px;
                height: 26px;
                padding: 0;
                border: 1px solid var(--bdsf-border);
                border-radius: 999px;
                background: transparent;
                color: inherit;
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
            }
            .bdsf-scroll-action-btn__icon {
                display: inline-block;
                transform: translateY(-2px);
            }
            .bdsf-scroll-action-btn:hover {
                background: color-mix(in srgb, var(--bdsf-text) 10%, transparent);
            }
            .bdsf-scroll-action-btn:disabled {
                opacity: 0.45;
                cursor: not-allowed;
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * 绑定与操作栏状态相关的全局事件。
     * 滚动和窗口尺寸变化都会影响“回到动态”按钮是否可用。
     */
    function bindGlobalEvents() {
        if (state.eventsBound) {
            return;
        }

        // 这里只监听页面主滚动，不捕获所有嵌套滚动容器。
        // 否则评论区内部、弹层内部的滚动也会触发整页按钮状态刷新，成本太高。
        window.addEventListener('scroll', scheduleScrollActionButtonStateRefresh, { passive: true });
        window.addEventListener('resize', scheduleLayoutRefresh, { passive: true });
        state.eventsBound = true;
    }

    /**
     * 监听动态流增量加载与主题切换。
     * 新卡片出现时重新处理；主题变化时同步刷新颜色和顶部偏移。
     */
    function startObservers() {
        if (!state.bodyObserver) {
            state.bodyObserver = new MutationObserver(records => {
                collectObservedCards(records);
                flushObservedCardRefresh();
            });

            state.bodyObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        if (!state.themeObserver) {
            state.themeObserver = new MutationObserver(scheduleLayoutRefresh);

            state.themeObserver.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['class', 'style', 'data-theme']
            });

            state.themeObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ['class', 'style']
            });
        }
    }

    /**
     * 统一的节流刷新入口。
     * 避免无限流加载、路由切换、窗口变化时反复全量扫描。
     */
    function scheduleFullRefresh() {
        if (state.fullRefreshTimerId) {
            window.clearTimeout(state.fullRefreshTimerId);
        }

        state.fullRefreshTimerId = window.setTimeout(() => {
            state.fullRefreshTimerId = 0;
            refreshAll();
        }, REFRESH_DELAY);
    }

    /**
     * 把观察器里收集到的受影响动态卡片缓存在 Set 中。
     * 这里既处理“新增了一整张动态”，也处理“已有动态内部新增了评论面板/按钮等子节点”。
     * @param {MutationRecord[]} records
     */
    function collectObservedCards(records) {
        for (const record of records) {
            for (const node of record.addedNodes) {
                collectCardsFromObservedNode(node);
            }
        }
    }

    /**
     * 将观察器捕获到的节点映射回受影响的最外层动态卡片。
     * @param {Node} node
     */
    function collectCardsFromObservedNode(node) {
        if (!(node instanceof Element)) {
            return;
        }

        const ownerCard = node.closest(CARD_SELECTOR);
        if (ownerCard instanceof HTMLElement && isTopLevelCardElement(ownerCard)) {
            state.pendingObservedCards.add(ownerCard);
        }

        if (node.matches(CARD_SELECTOR) && isTopLevelCardElement(node)) {
            state.pendingObservedCards.add(node);
        }

        node.querySelectorAll(CARD_SELECTOR).forEach(card => {
            if (card instanceof HTMLElement && isTopLevelCardElement(card)) {
                state.pendingObservedCards.add(card);
            }
        });
    }

    /**
     * 把观察器里积累的卡片刷新合并到一帧中执行。
     * 这样无限流追加多条动态时，不会每插入一个节点就触发一次整页扫描。
     */
    function flushObservedCardRefresh() {
        if (state.cardRefreshFrameId || state.pendingObservedCards.size === 0) {
            return;
        }

        state.cardRefreshFrameId = window.requestAnimationFrame(() => {
            state.cardRefreshFrameId = 0;

            state.pendingObservedCards.forEach(card => {
                if (!(card instanceof HTMLElement) || !card.isConnected || !isTopLevelCardElement(card)) {
                    return;
                }

                prepareStickyFooter(card);
            });

            state.pendingObservedCards.clear();
            refreshViewportState();
        });
    }

    /**
     * 执行一次完整刷新。
     * 会同步刷新主题色、sticky 偏移，并扫描当前页面内已有动态卡片。
     */
    function refreshAll() {
        if (!document.body) {
            return;
        }

        ensureStyle();
        refreshLayoutState();
        refreshCardStructures(document);
        refreshViewportState();
    }

    /**
     * 只刷新布局相关状态。
     * 这里包含主题色变量与 sticky 顶部偏移。
     */
    function refreshLayoutState() {
        refreshThemeTokens();
        refreshStickyTop();
    }

    /**
     * 只刷新与视口位置有关的按钮状态。
     * 这里不碰 DOM 结构，适合滚动、布局变化等高频场景。
     */
    function refreshViewportState() {
        updateScrollActionButtonStates();
    }

    /**
     * 扫描并处理当前作用域内的动态卡片结构。
     * 这里只处理最外层卡片，避免误改转发卡片内部的嵌套结构。
     * @param {ParentNode} root
     */
    function refreshCardStructures(root) {
        const cards = [];

        if (root instanceof Element && root.matches(CARD_SELECTOR)) {
            cards.push(root);
        }

        cards.push(...root.querySelectorAll(CARD_SELECTOR));

        cards.forEach(card => {
            if (!(card instanceof HTMLElement) || !isTopLevelCardElement(card)) {
                return;
            }

            prepareStickyFooter(card);
        });
    }

    /**
     * 为单张动态卡片准备吸附操作栏。
     * 这里保留原脚本的 DOM 重排方式，确保视觉与交互习惯不变。
     * @param {HTMLElement} card
     */
    function prepareStickyFooter(card) {
        const cardStructure = resolveCardStructure(card);
        if (!cardStructure) {
            return;
        }

        const { main, footer } = cardStructure;

        if (footer.parentElement !== card || !isNodeBefore(main, footer)) {
            card.insertBefore(footer, main);
            card.insertBefore(main, footer);
        }

        footer.classList.add('bdsf-sticky-footer');
        bindCommentScrollBehavior(footer, main, card);
        ensureScrollActionButton(footer, main, card);
    }

    /**
     * 调整评论按钮左键交互。
     * 仅当“当前是关闭评论区”且正文不在视口内时，才先滚动再执行原生关闭。
     * @param {HTMLElement} footer
     * @param {HTMLElement} main
     * @param {HTMLElement} card
     */
    function bindCommentScrollBehavior(footer, main, card) {
        const commentButton = getCardCommentButton(footer);
        if (!(commentButton instanceof HTMLElement) || commentButton.dataset.bdsfBound === '1') {
            return;
        }

        commentButton.dataset.bdsfBound = '1';

        commentButton.addEventListener('click', event => {
            if (state.commentCloseBypassButtons.has(commentButton)) {
                state.commentCloseBypassButtons.delete(commentButton);
                return;
            }

            // 评论区当前未展开，这次点击属于“打开”，保持 B 站原生行为。
            if (!hasExpandedPanel(card)) {
                return;
            }

            // 吸附后的操作栏本身常驻视口，所以判断是否要预滚动时，
            // 必须看正文主区域而不是看整张卡片。
            if (isElementPartiallyVisible(main, getViewportTopOffset())) {
                return;
            }

            // 这里拦截原生关闭，等滚到合适位置后再补发一次点击。
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            scrollElementToViewportTop(card, 'smooth');
            waitForElementScrollToSettle(card, () => {
                if (!commentButton.isConnected) {
                    return;
                }

                state.commentCloseBypassButtons.add(commentButton);
                commentButton.click();
            });
        }, true);
    }

    /**
     * 为操作栏创建独立的“回到动态”按钮。
     * 这个按钮只负责滚动，不再复用评论按钮的右键行为。
     * @param {HTMLElement} footer
     * @param {HTMLElement} main
     * @param {HTMLElement} card
     */
    function ensureScrollActionButton(footer, main, card) {
        let button = footer.querySelector('.bdsf-scroll-action-btn');
        if (!(button instanceof HTMLButtonElement)) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'bdsf-scroll-action-btn';
            button.innerHTML = '<span class="bdsf-scroll-action-btn__icon">↑</span>';
            button.title = '回到动态';
            button.setAttribute('aria-label', '回到动态');
            footer.appendChild(button);
        }

        button.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            scrollElementToViewportTop(card, 'smooth');
        };

        // 这里缓存按钮对应的 card/main，滚动时就不需要反复 querySelector/closest。
        state.scrollActionButtons.add(button);
        state.scrollActionButtonMeta.set(button, { card, main });

        updateScrollActionButtonState(button, card, main);
    }

    /**
     * 将高频的滚动/缩放刷新合并到下一帧执行。
     * 这样可以避免每一个 scroll event 都同步做一次全量状态计算。
     */
    function scheduleScrollActionButtonStateRefresh() {
        if (state.viewportStateFrameId) {
            return;
        }

        state.viewportStateFrameId = window.requestAnimationFrame(() => {
            state.viewportStateFrameId = 0;
            updateScrollActionButtonStates();
        });
    }

    /**
     * 把主题色和顶部偏移的刷新合并到一帧中执行。
     * 主题切换时 class/style 往往会连发，合并后可避免重复读取样式。
     */
    function scheduleLayoutRefresh() {
        if (state.layoutRefreshFrameId) {
            return;
        }

        state.layoutRefreshFrameId = window.requestAnimationFrame(() => {
            state.layoutRefreshFrameId = 0;
            refreshLayoutState();
            refreshViewportState();
        });
    }

    /**
     * 刷新主题色变量。
     * 优先读取 B 站自身 CSS 变量；读不到时回退到页面真实计算色。
     */
    function refreshThemeTokens() {
        const rootStyle = window.getComputedStyle(document.documentElement);
        const bodyStyle = window.getComputedStyle(document.body);
        const sampleCard = document.querySelector(CARD_SELECTOR);
        const sampleStyle = sampleCard instanceof HTMLElement
            ? window.getComputedStyle(sampleCard)
            : bodyStyle;

        const surface = pickFirstVisibleColor(
            rootStyle.getPropertyValue('--bg1'),
            rootStyle.getPropertyValue('--bg2'),
            rootStyle.getPropertyValue('--background-color'),
            sampleStyle.backgroundColor,
            bodyStyle.backgroundColor,
            'rgba(255, 255, 255, 0.96)'
        );
        const text = pickFirstVisibleColor(
            rootStyle.getPropertyValue('--text1'),
            rootStyle.getPropertyValue('--text2'),
            sampleStyle.color,
            bodyStyle.color,
            '#18191c'
        );
        const border = pickFirstVisibleColor(
            rootStyle.getPropertyValue('--line_regular'),
            rootStyle.getPropertyValue('--line_light'),
            withAlpha(text, isDarkColor(surface) ? 0.16 : 0.10)
        );

        document.documentElement.style.setProperty('--bdsf-surface', surface);
        document.documentElement.style.setProperty('--bdsf-text', text);
        document.documentElement.style.setProperty('--bdsf-border', border);
    }

    /**
     * 刷新吸附操作栏距离顶部的偏移量。
     * 这里会尝试识别页面固定顶栏，并额外兼容不同动态页布局。
     */
    function refreshStickyTop() {
        const headerSelectors = [
            '.bili-header',
            '.bili-header__bar',
            '#bili-header-container',
            '.bili-dyn-home--header'
        ];

        let top = DEFAULT_STICKY_TOP;

        for (const selector of headerSelectors) {
            const header = document.querySelector(selector);
            if (!(header instanceof HTMLElement)) {
                continue;
            }

            const rect = header.getBoundingClientRect();
            if (rect.height > 0) {
                top = Math.max(top, Math.round(rect.bottom));
                break;
            }
        }

        document.documentElement.style.setProperty('--bdsf-sticky-top', `${top}px`);
    }

    /**
     * 接管 history.pushState / replaceState。
     * B 站动态页是 SPA，路由切换后不重新挂脚本，所以这里手动补刷新。
     */
    function hookHistoryMethods() {
        if (state.historyHooked) {
            return;
        }

        const methods = ['pushState', 'replaceState'];
        methods.forEach(methodName => {
            const originalMethod = history[methodName];
            history[methodName] = function (...args) {
                const result = originalMethod.apply(this, args);
                scheduleFullRefresh();
                return result;
            };
        });

        state.historyHooked = true;
    }

    /**
     * 判断节点 a 在文档顺序上是否位于节点 b 之前。
     * @param {Node} a
     * @param {Node} b
     * @returns {boolean}
     */
    function isNodeBefore(a, b) {
        return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    /**
     * 判断一张动态是否是当前页面里需要直接处理的最外层动态。
     * 转发卡片内部的嵌套动态会被排除，避免误改其内部结构。
     * @param {HTMLElement} card
     * @returns {boolean}
     */
    function isTopLevelCardElement(card) {
        return !card.parentElement?.closest(CARD_SELECTOR);
    }

    /**
     * 解析一张动态卡片的核心结构节点。
     * 这里把 main/footer 的取法统一收口，后面 B 站若改 DOM，只需优先改这里。
     * @param {HTMLElement} card
     * @returns {{ main: HTMLElement, footer: HTMLElement } | null}
     */
    function resolveCardStructure(card) {
        const main = getCardMain(card);
        const footer = getCardFooter(card);
        if (!(main instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
            return null;
        }

        return { main, footer };
    }

    /**
     * 获取当前动态卡片的正文主区域。
     * @param {HTMLElement} card
     * @returns {HTMLElement | null}
     */
    function getCardMain(card) {
        const main = card.querySelector(CARD_ADAPTER.main);
        return main instanceof HTMLElement ? main : null;
    }

    /**
     * 获取当前动态卡片自己的操作栏。
     * @param {HTMLElement} card
     * @returns {HTMLElement | null}
     */
    function getCardFooter(card) {
        const footer = findOwnedDescendant(card, CARD_ADAPTER.footer);
        return footer instanceof HTMLElement ? footer : null;
    }

    /**
     * 获取当前动态卡片自己的评论/互动面板。
     * @param {HTMLElement} card
     * @returns {HTMLElement | null}
     */
    function getCardPanel(card) {
        const panel = findOwnedDescendant(card, CARD_ADAPTER.panel);
        return panel instanceof HTMLElement ? panel : null;
    }

    /**
     * 获取操作栏中的评论按钮。
     * @param {HTMLElement} footer
     * @returns {HTMLElement | null}
     */
    function getCardCommentButton(footer) {
        const button = footer.querySelector(CARD_ADAPTER.commentButton);
        return button instanceof HTMLElement ? button : null;
    }

    /**
     * 在当前动态卡片内部查找“属于它自己”的后代节点。
     * 这里不要求节点必须是直属子级，但要求该节点向上最近的动态卡片就是当前 card，
     * 这样既能兼容 B 站真实 DOM 层级，又能避开转发卡片里的嵌套同类节点。
     * @param {HTMLElement} card
     * @param {string} selector
     * @returns {Element | null}
     */
    function findOwnedDescendant(card, selector) {
        const candidates = card.querySelectorAll(selector);
        for (const candidate of candidates) {
            if (!(candidate instanceof Element)) {
                continue;
            }

            if (candidate.closest(CARD_SELECTOR) === card) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * 当前动态是否已经展开评论/互动面板。
     * @param {HTMLElement} card
     * @returns {boolean}
     */
    function hasExpandedPanel(card) {
        return getCardPanel(card) instanceof HTMLElement;
    }

    /**
     * 判断元素是否至少仍有一部分在当前可视内容区内。
     * 顶部固定栏区域会通过 topOffset 排除。
     * @param {HTMLElement} element
     * @param {number} [topOffset=0]
     * @returns {boolean}
     */
    function isElementPartiallyVisible(element, topOffset = 0) {
        const rect = element.getBoundingClientRect();
        return rect.bottom > topOffset && rect.top < window.innerHeight;
    }

    /**
     * 刷新单个“回到动态”按钮的启用状态。
     * 只有评论区已打开且正文完全离开可视区时，按钮才允许点击。
     * @param {HTMLButtonElement} button
     * @param {HTMLElement} card
     * @param {HTMLElement} main
     */
    function updateScrollActionButtonState(button, card, main) {
        if (!hasExpandedPanel(card)) {
            button.disabled = true;
            button.title = '评论区未打开，无法滚动';
            button.setAttribute('aria-disabled', 'true');
            return;
        }

        const isMainVisible = isElementPartiallyVisible(main, getViewportTopOffset());
        button.disabled = isMainVisible;
        button.title = isMainVisible ? '当前动态仍在页面中，无法滚动' : '回到动态';
        button.setAttribute('aria-disabled', String(isMainVisible));
    }

    /**
     * 批量刷新页面里所有“回到动态”按钮状态。
     */
    function updateScrollActionButtonStates() {
        state.scrollActionButtons.forEach(button => {
            if (!(button instanceof HTMLButtonElement)) {
                return;
            }

            if (!button.isConnected) {
                state.scrollActionButtons.delete(button);
                return;
            }

            const meta = state.scrollActionButtonMeta.get(button);
            const card = meta?.card;
            const main = meta?.main;

            if (!(card instanceof HTMLElement) || !(main instanceof HTMLElement) || !card.isConnected || !main.isConnected) {
                state.scrollActionButtons.delete(button);
                return;
            }

            updateScrollActionButtonState(button, card, main);
        });
    }

    /**
     * 将指定元素滚动到视口顶部附近，并自动避开固定顶栏。
     * @param {HTMLElement} element
     * @param {'auto' | 'smooth'} behavior
     */
    function scrollElementToViewportTop(element, behavior) {
        const rect = element.getBoundingClientRect();
        const topOffset = getViewportTopOffset();
        const targetTop = window.scrollY + rect.top - topOffset - SCROLL_ALIGN_MARGIN;

        window.scrollTo({
            top: Math.max(0, targetTop),
            behavior
        });
    }

    /**
     * 等待滚动基本到位或停止，再继续执行后续逻辑。
     * 这里不再依赖固定毫秒数，避免长距离滚动时提前关闭评论区。
     * 如果浏览器平滑滚动提前停下，也会补一次瞬时对齐来兜底。
     * @param {HTMLElement} element
     * @param {() => void} callback
     */
    function waitForElementScrollToSettle(element, callback) {
        const startTime = performance.now();
        const expectedTop = getViewportTopOffset() + SCROLL_ALIGN_MARGIN;
        let stableFrameCount = 0;
        let lastScrollY = window.scrollY;

        const check = () => {
            if (!(element instanceof HTMLElement) || !element.isConnected) {
                return;
            }

            const rect = element.getBoundingClientRect();
            const distanceToTarget = Math.abs(rect.top - expectedTop);
            if (distanceToTarget <= 2) {
                callback();
                return;
            }

            const currentScrollY = window.scrollY;
            if (Math.abs(currentScrollY - lastScrollY) <= 1) {
                stableFrameCount += 1;
            } else {
                stableFrameCount = 0;
            }
            lastScrollY = currentScrollY;

            const elapsed = performance.now() - startTime;
            if ((elapsed >= 120 && stableFrameCount >= 4) || elapsed >= 1000) {
                // 最后再强制对齐一次，尽量兑现“先滚到位再关闭”的交互承诺。
                scrollElementToViewportTop(element, 'auto');
                callback();
                return;
            }

            window.requestAnimationFrame(check);
        };

        window.requestAnimationFrame(check);
    }

    /**
     * 获取页面顶部需要预留的固定占位高度。
     * 这里优先复用脚本已计算出的 sticky top，以保持滚动对齐口径一致。
     * @returns {number}
     */
    function getViewportTopOffset() {
        const cssValue = window.getComputedStyle(document.documentElement)
            .getPropertyValue('--bdsf-sticky-top')
            .trim();
        const parsed = Number.parseFloat(cssValue);
        return Number.isFinite(parsed) ? parsed : DEFAULT_STICKY_TOP;
    }

    /**
     * 从一组候选颜色里，挑出第一个有效且非透明的颜色字符串。
     * @param {...string} colors
     * @returns {string}
     */
    function pickFirstVisibleColor(...colors) {
        for (const color of colors) {
            const normalized = String(color || '').trim();
            if (!normalized || isTransparentColor(normalized)) {
                continue;
            }

            return normalized;
        }

        return '#ffffff';
    }

    /**
     * 判断一个颜色值是否等同于透明。
     * @param {string} color
     * @returns {boolean}
     */
    function isTransparentColor(color) {
        const normalized = color.replace(/\s+/g, '').toLowerCase();
        return (
            normalized === 'transparent' ||
            normalized === 'rgba(0,0,0,0)' ||
            normalized === 'hsla(0,0%,0%,0)'
        );
    }

    /**
     * 给颜色套上一层新的透明度。
     * 当前支持 rgb/rgba/hex 三类常见颜色写法。
     * @param {string} color
     * @param {number} alpha
     * @returns {string}
     */
    function withAlpha(color, alpha) {
        const parsed = parseColor(color);
        if (!parsed) {
            return color;
        }

        return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
    }

    /**
     * 判断颜色整体更偏亮还是更偏暗。
     * 这里只用于决定边框透明度回退值。
     * @param {string} color
     * @returns {boolean}
     */
    function isDarkColor(color) {
        const parsed = parseColor(color);
        if (!parsed) {
            return false;
        }

        const luminance = (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255;
        return luminance < 0.55;
    }

    /**
     * 解析常见 CSS 颜色格式。
     * @param {string} color
     * @returns {{ r: number, g: number, b: number } | null}
     */
    function parseColor(color) {
        const normalized = String(color || '').trim();

        const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/i);
        if (rgbMatch) {
            const parts = rgbMatch[1]
                .split(',')
                .slice(0, 3)
                .map(part => Number.parseFloat(part.trim()));

            if (parts.length === 3 && parts.every(Number.isFinite)) {
                return {
                    r: clampColorChannel(parts[0]),
                    g: clampColorChannel(parts[1]),
                    b: clampColorChannel(parts[2])
                };
            }
        }

        const hexMatch = normalized.match(/^#([0-9a-f]{3,8})$/i);
        if (!hexMatch) {
            return null;
        }

        let hex = hexMatch[1];
        if (hex.length === 3 || hex.length === 4) {
            hex = hex.split('').map(char => char + char).join('');
        }

        if (hex.length !== 6 && hex.length !== 8) {
            return null;
        }

        return {
            r: Number.parseInt(hex.slice(0, 2), 16),
            g: Number.parseInt(hex.slice(2, 4), 16),
            b: Number.parseInt(hex.slice(4, 6), 16)
        };
    }

    /**
     * 约束颜色通道值范围，避免异常输入污染结果。
     * @param {number} value
     * @returns {number}
     */
    function clampColorChannel(value) {
        return Math.max(0, Math.min(255, Math.round(value)));
    }

    console.info(`[${SCRIPT_NAME}] 已启动`);
})();
