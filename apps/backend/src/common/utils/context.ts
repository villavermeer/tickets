import {AsyncLocalStorage} from 'async_hooks';

const asyncLocalStorage = new AsyncLocalStorage<Map<string, any>>();

export const Context = {
    set: (key: string, value: any) => {
        const store = asyncLocalStorage.getStore();
        if (store) {
            store.set(key, value);
        }
    },
    get: <T>(key: string): any => {
        const store = asyncLocalStorage.getStore();
        return store ? store.get(key) as T : undefined;
    },
    run: (fn: () => void) => {
        asyncLocalStorage.run(new Map(), fn);
    },
};