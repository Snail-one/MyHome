export const defaultSearchEngines = {
    google: {
        name: 'Google',
        urlTemplate: 'https://www.google.com/search?q={query}',
        placeholder: '搜索 Google...'
    },
    youtube: {
        name: 'YouTube',
        urlTemplate: 'https://www.youtube.com/results?search_query={query}',
        placeholder: '在 YouTube 搜索...'
    },
    github: {
        name: 'GitHub',
        urlTemplate: 'https://github.com/search?q={query}',
        placeholder: '搜索 GitHub...'
    },
    bilibili: {
        name: '哔哩哔哩',
        urlTemplate: 'https://search.bilibili.com/all?keyword={query}',
        placeholder: '在 B 站搜索...'
    }
};

export const DEFAULT_SETTINGS = {
    layoutColumns: 0,
    projectLayoutColumns: 0,
    editMode: false,
    projectLinkDisplayMode: 'centered',
    bookmarkLinkDisplayMode: 'centered',
    projectLinkSize: 'medium',
    bookmarkLinkSize: 'medium',
    backgroundUrl: ''
};

export const REQUIRED_EMAIL_LINK_KEYS = new Set(['google-mail']);

export const LINK_SIZE_OPTIONS = [
    { size: 'small', label: '小' },
    { size: 'medium', label: '默认' },
    { size: 'large', label: '大' },
    { size: 'xlarge', label: '超大' }
];

export const LINK_SIZE_CONFIG = {
    small: {
        cardWidth: '96px',
        minHeight: '78px',
        addCardMinHeight: '78px',
        iconSize: '30px',
        titleSize: '13px',
        cardGap: '6px',
        cardPadding: '10px',
        gridGap: '12px',
        addIconSize: '34px',
        addIconSvgSize: '20px'
    },
    medium: {
        cardWidth: '120px',
        minHeight: 'auto',
        addCardMinHeight: '92px',
        iconSize: 'clamp(30px, 3.5vmin, 40px)',
        titleSize: 'clamp(14px, 1.6vw, 18px)',
        cardGap: 'clamp(6px, 0.8vw, 10px)',
        cardPadding: 'clamp(10px, 1.2vw, 16px)',
        gridGap: 'var(--nav-gap)',
        addIconSize: '42px',
        addIconSvgSize: '24px'
    },
    large: {
        cardWidth: '144px',
        minHeight: '112px',
        addCardMinHeight: '112px',
        iconSize: '48px',
        titleSize: '17px',
        cardGap: '12px',
        cardPadding: '16px',
        gridGap: '18px',
        addIconSize: '50px',
        addIconSvgSize: '28px'
    },
    xlarge: {
        cardWidth: '168px',
        minHeight: '132px',
        addCardMinHeight: '132px',
        iconSize: '56px',
        titleSize: '18px',
        cardGap: '14px',
        cardPadding: '18px',
        gridGap: '20px',
        addIconSize: '58px',
        addIconSvgSize: '32px'
    }
};

export function createAppState() {
    return {
        user: null,
        links: [],
        emailLinks: [],
        projectLinks: [],
        searchEngineRecords: [],
        settings: { ...DEFAULT_SETTINGS }
    };
}
