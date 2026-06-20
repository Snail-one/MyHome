export function buildSearchUrl(engineConfig, query) {
    const encodedQuery = encodeURIComponent(query);
    if (engineConfig?.urlTemplate) {
        if (engineConfig.urlTemplate.includes('{query}')) {
            return engineConfig.urlTemplate.replaceAll('{query}', encodedQuery);
        }

        const separator = engineConfig.urlTemplate.includes('?') ? '&' : '?';
        return `${engineConfig.urlTemplate}${separator}q=${encodedQuery}`;
    }

    return engineConfig?.url ? engineConfig.url + encodedQuery : '#';
}

export function getEngineKey(engine) {
    return engine.engineKey || `custom-${engine.id}`;
}

export function getFallbackSearchEngineRecords(defaultEngines) {
    return Object.entries(defaultEngines).map(([engineKey, config]) => ({
        id: engineKey,
        engineKey,
        name: config.name,
        urlTemplate: config.urlTemplate
    }));
}
