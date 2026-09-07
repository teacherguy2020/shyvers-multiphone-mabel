# Harmony configuration

Harmony mappings are installation-specific and are intentionally not included
in this repository. Do not copy another installation's mapping: hub IDs,
device IDs, activity IDs, command sets, and network addresses belong to the
owner's Harmony system.

## Generate a local mapping

Export the Harmony configuration for your own hub, keep the export outside Git,
then run:

```sh
node operator/harmony_config.mjs --input "/path/to/your-Harmony-config.md"
```

This generates local files at:

- `config/harmony-mapping.json`
- `config/harmony-mapping.md`

They are ignored by Git. Set `HARMONY_HOST`, `HARMONY_PORT`, `HARMONY_DOMAIN`,
and `HARMONY_HUB_ID` for the client. The Mabel Denon ducking integration also
requires `HARMONY_VOLUME_DEVICE_ID`; it must be the user's own receiver/device
ID from the generated mapping. If it is absent, Mabel continues without
Harmony volume ducking.
Use the generated mapping to identify your own device/activity IDs and exact
command names. Do not copy the IDs used by another installation.
