// Child-process-only fault injection: simulate a BullMQ timer that appears
// after shutdown promises have settled, without changing BullMQ internals.
process.once('beforeExit', () => {
  setTimeout(() => undefined, 30_000);
  process.stdout.write('Synthetic test late handle armed\n');
});
