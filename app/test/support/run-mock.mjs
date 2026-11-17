// Starts the unmodified kit mock on a free port with its state in a temp file,
// so tests never touch the kit's own .mock-state.json or a mock running on 8787.
import { createMockServer } from '../../../mobile-engineer-kit/mock-server.mjs';

const server = createMockServer({ statePath: process.argv[2] });
server.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`));
