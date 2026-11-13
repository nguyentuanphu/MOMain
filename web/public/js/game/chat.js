// The chat: a log of messages and an input line opened with Enter, like the
// client's chat window (UI/Chat). Commands such as "/move devias" go to the server
// as normal chat messages, which is how the client sends them too.

const MAX_LINES = 60;

export class Chat {
  constructor({ log, form, input }) {
    this.log = log;
    this.form = form;
    this.input = input;
    this.send = null;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      input.value = '';
      this.close();
      if (text) this.send?.(text);
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && document.activeElement !== input && !form.hidden && this.send) {
        event.preventDefault();
        input.focus();
      } else if (event.key === 'Escape' && document.activeElement === input) {
        input.value = '';
        this.close();
      }
    });
  }

  enable(send) {
    this.send = send;
    this.log.hidden = false;
    this.form.hidden = false;
  }

  close() {
    this.input.blur();
  }

  add(text, kind = 'chat') {
    const line = document.createElement('div');
    line.className = `line ${kind}`;
    line.textContent = text;
    this.log.append(line);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
}
