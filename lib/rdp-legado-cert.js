'use strict';

// Certificado X.509 de fachada, usado SÓ no modo legado.
//
// O RDCleanPath Response exige uma cadeia de certificados e o IronRDP recusa
// se ela vier vazia ("server cert chain missing from rdcleanpath response").
// Em RDP legado não existe TLS nem certificado de servidor de verdade, e com
// enable_credssp=false a chave pública não é usada para nada — mas o cliente
// ainda faz o parse, então precisa ser um X.509 válido.
//
// ATENÇÃO: isto NÃO autentica servidor nenhum. É um preenchimento de campo.

const DER_BASE64 =
  "MIIDGTCCAgGgAwIBAgIUMWh6jO1zwgIV1bm8L6J1YB6Z8TUwDQYJKoZIhvcNAQELBQAwHDEaMBgG" +
  "A1UEAwwRdmluY2lpLWxlZ2FjeS1yZHAwHhcNMjYwODAzMTYxNDE3WhcNMzYwNzMxMTYxNDE3WjAc" +
  "MRowGAYDVQQDDBF2aW5jaWktbGVnYWN5LXJkcDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC" +
  "ggEBALaY9yCp5gXDViMo3/3PPVt/KbWKjAb0WnqRBgB62qegaz9x1JF6hNOcsZtWX2KJX2L/e0m6" +
  "6B7DuB20B/SlLviuDSQ128CYKOPfnAB1jgKdpf0wsgJrPvLJKW/yGxvV3NwUvU6qI52e+SJmapkV" +
  "Dmhu5a+BfyX4ZT+vSUVSaHlCXzNgc5gRPCnFTXwrENjlft31Lp05GFPY3SoZ4VTB1tMrBUcw+No1" +
  "hlWYOPBZ8tisSz0vJB82bf2eo0Rn0rC/eWFKksEuDXVzzGV4WKGz8dxEJcJUtMShbbk3Dpr2BvGt" +
  "yFmatRMEKBg0Ip9N9B4pSRuInpWCeA5+oQDfqGugVO8CAwEAAaNTMFEwHQYDVR0OBBYEFOrAdW1B" +
  "kGKQDvuzUxSZnJR7HO8dMB8GA1UdIwQYMBaAFOrAdW1BkGKQDvuzUxSZnJR7HO8dMA8GA1UdEwEB" +
  "/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAFVT4LG5SbCSUJaZn6le4+46qX/7pUX/ScCrNHNj" +
  "Bh6nrZdDMudS2DS7earjZsaAbWHC5cnQyAuyUA48YeUqWAjkVIiMLS7eIc/L9ZykzatGUN9DVHxw" +
  "cs2m1qLLQkzIwnPsBBQPTdojEaOAFtAysmW9+lUQn/d42Ol/kZRygAEVMH//uTF+VGHDbyc78sGF" +
  "14KFifciOoYOL80F5r4OU8UfQQQ1EF+6+YlxJlLoHT8ppozfZUvoMhcMxEUutTw3ncZv1zNfxe2Y" +
  "rAjkasfuMbuEHSHo5uF7J3pDkJllNJs33VWri/yPqRRcokvg6L4yWPYWTZ/3XnG54qpIb/YNj+s=";

module.exports = { CERT_FACHADA: Buffer.from(DER_BASE64, "base64") };
