class ULANZIEventEmitter {
    constructor (id, debug = false) {

        const eventList = new Map();
        const ALLEVENTS = "*";

        eventList.hasWildcard = function(name, data) {
            for(const [key, value] of this) {
                if(key !== ALLEVENTS && key.includes(ALLEVENTS) && new RegExp(`^${key.split(/\*+/).join('.*')}$`).test(name)) {
                    if(data) value.pub(data, name);
                    else return true;
                }
            }
        };

        this.on = (name, fn) => {
            if(!eventList.has(name)) eventList.set(name, ULANZIEventEmitter.pubSub());
            return eventList.get(name).sub(fn);
        };

        this.has = name => eventList.has(name);
        this.hasMatch = name => eventList.has(name) || eventList.hasWildcard(name);
        this.emit = (name, data) => {
            eventList.has(name) && eventList.get(name).pub(data, name);
            eventList.has(ALLEVENTS) && eventList.get(ALLEVENTS).pub(data, name);
            eventList.hasWildcard(name, data);
        };

        return this;
    }

    static pubSub() {
        const subscribers = new Set();

        const sub = fn => {
            subscribers.add(fn);
            return () => {
                subscribers.delete(fn);
            };
        };

        const pub = (data, name) => subscribers.forEach(fn => fn(data, name));
        return Object.freeze({pub, sub});
    }
}

const EventEmitter = new ULANZIEventEmitter();