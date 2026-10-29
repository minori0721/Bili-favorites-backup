# Playback HTTPS fixture

This self-signed certificate and its public test private key are used only by
loopback HTTPS tests. They are not deployment credentials.

The certificate covers `playback.test.invalid` and is valid from 2020 to 2040.
Each trusted test client loads it through its own `NODE_EXTRA_CA_CERTS` process
environment. Certificate verification remains enabled; the parent process and
the machine trust store are unchanged.
