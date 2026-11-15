// Wake signal: a durable write calls notify(); a waiting cycle returns early. A notify with no waiter is kept for the next wait.
export function createWakeSignal() {
  let waiting = null;
  let notified = false;
  return {
    notify() {
      notified = true;
      if (waiting) waiting();
    },
    wait(ms) {
      if (notified) {
        notified = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const timer = setTimeout(finish, ms);
        function finish() {
          clearTimeout(timer);
          waiting = null;
          notified = false;
          resolve();
        }
        waiting = finish;
      });
    },
  };
}
