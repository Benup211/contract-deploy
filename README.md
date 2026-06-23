### Command for Deployment

## Deploying Vault

```bash
pnpm deploy:vault --treasury <ss58_address> --netuid <netuid>
```
## Deploying Treasury

```bash
pnpm deploy:treasury --token <ss58_address>
```
## Deploying Governance

The script automatically uploads the `tusdt_election` wasm and passes the resulting code hash to
`tusdt-governance::new`, which instantiates the election contract internally.

```bash
pnpm deploy:governance --treasury <ss58_address> --vault <ss58_address> --auction <ss58_address> --oracle <ss58_address> --maintainer <ss58_address>
```


