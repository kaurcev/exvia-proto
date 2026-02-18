
```JavaScript
import { Client, LocalStorageStorage } from './sdk';

const client = new Client(); // использует localStorage по умолчанию

client.on('connected', (url) => console.log('Connected to', url));
client.on('message', (from, content) => {
  const text = new TextDecoder().decode(content);
  console.log('Message from', from, text);
});

client.addServer('ws://localhost:8080');
client.selectServer('ws://localhost:8080');
client.connect().then(() => {
  client.sendTo(targetPublicKeyHex, 'Hello, world!');
});
```