export class OrderedAsyncQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.closed = false;
  }

  enqueue(promise, {onSuccess = () => {}, onError = () => {}, onSettled = () => {}} = {}) {
    const settled = Promise.resolve(promise).then(
      (value) => ({status: "fulfilled", value}),
      (error) => ({status: "rejected", error})
    );

    this.tail = this.tail.then(async () => {
      const result = await settled;

      if (this.closed) {
        return;
      }

      if (result.status === "fulfilled") {
        onSuccess(result.value);
      } else {
        onError(result.error);
      }

      onSettled();
    });

    return this.tail;
  }

  close() {
    this.closed = true;
  }
}
