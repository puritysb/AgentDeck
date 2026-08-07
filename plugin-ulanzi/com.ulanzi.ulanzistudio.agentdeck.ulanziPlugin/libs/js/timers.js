/* global USDTimerWorker */

let USDTimerWorker = new Worker(URL.createObjectURL(
    new Blob([timerFn.toString().replace(/^[^{]*{\s*/, '').replace(/\s*}[^}]*$/, '')], {type: 'text/javascript'})
));
USDTimerWorker.timerId = 1;
USDTimerWorker.timers = {};
const USDDefaultTimeouts = {
    timeout: 0,
    interval: 10
};

Object.freeze(USDDefaultTimeouts);

function _setTimer(callback, delay, type, params) {
    const id = USDTimerWorker.timerId++;
    USDTimerWorker.timers[id] = {callback, params};
    USDTimerWorker.onmessage = (e) => {
        if(USDTimerWorker.timers[e.data.id]) {
            if(e.data.type === 'clearTimer') {
                delete USDTimerWorker.timers[e.data.id];
            } else {
                const cb = USDTimerWorker.timers[e.data.id].callback;
                if(cb && typeof cb === 'function') cb(...USDTimerWorker.timers[e.data.id].params);
            }
        }
    };
    USDTimerWorker.postMessage({type, id, delay});
    return id;
}

function _setTimeoutUSD(...args) {
    let [callback, delay = 0, ...params] = [...args];
    return _setTimer(callback, delay, 'setTimeout', params);
}

function _setIntervalUSD(...args) {
    let [callback, delay = 0, ...params] = [...args];
    return _setTimer(callback, delay, 'setInterval', params);
}

function _clearTimeoutUSD(id) {
    USDTimerWorker.postMessage({type: 'clearTimeout', id}); //     USDTimerWorker.postMessage({type: 'clearInterval', id}); = same thing
    delete USDTimerWorker.timers[id];
}

window.setTimeout = _setTimeoutUSD;
window.setInterval = _setIntervalUSD;
window.clearTimeout = _clearTimeoutUSD; //timeout and interval share the same timer-pool
window.clearInterval = _clearTimeoutUSD;



function timerFn() {

    let timers = {};
    let debug = false;
    let supportedCommands = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'];

    function log(e) {console.log('Worker-Info::Timers', timers);}

    function clearTimerAndRemove(id) {
        if(timers[id]) {
            if(debug) console.log('clearTimerAndRemove', id, timers[id], timers);
            clearTimeout(timers[id]);
            delete timers[id];
            postMessage({type: 'clearTimer', id: id});
            if(debug) log();
        }
    }

    onmessage = function(e) {
        // first see, if we have a timer with this id and remove it
        // this automatically fulfils clearTimeout and clearInterval
        supportedCommands.includes(e.data.type) && timers[e.data.id] && clearTimerAndRemove(e.data.id);
        if(e.data.type === 'setTimeout') {
            timers[e.data.id] = setTimeout(() => {
                postMessage({id: e.data.id});
                clearTimerAndRemove(e.data.id); //cleaning up
            }, Math.max(e.data.delay || 0));
        } else if(e.data.type === 'setInterval') {
            timers[e.data.id] = setInterval(() => {
                postMessage({id: e.data.id});
            }, Math.max(e.data.delay || USDDefaultTimeouts.interval));
        }
    };
}
