# Firma de Windows (Azure Artifact Signing)

Windows 11 con **Smart App Control** activado bloquea cualquier `.exe` o `.dll` sin firma de una autoridad reconocida, y no permite excepciones por app. Por eso el workflow `release` firma el build de Windows con [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (antes *Trusted Signing*) antes de crear el `.zip`. Se firman todos los binarios del paquete (`.exe`, `.dll` y `.node`).

No se firma en los PR. Si faltan las variables de abajo, el build sigue y sale **sin firmar** (con un aviso en el resumen del workflow).

## Configuración (una vez)

1. **En Azure:**
   - Crea una cuenta de *Artifact Signing* y anota su **endpoint** (depende de la región; por ejemplo `https://eus.codesigning.azure.net/`).
   - Completa la **validación de identidad** (*Public Trust*, individual u organización) y crea un **perfil de certificado** *Public Trust*.
2. **App de Entra ID con credencial federada (OIDC, sin secretos):**
   - En *Microsoft Entra ID → Registros de aplicaciones*, crea una app.
   - En *Certificados y secretos → Credenciales federadas*, añade una de GitHub Actions con organización `ignaciovillela`, repositorio `usage-monitor`, tipo de entidad **Environment** y nombre `signing`.
   - En la cuenta de Artifact Signing (*Control de acceso (IAM)*), dale a esa app el rol **Artifact Signing Certificate Profile Signer**.
3. **En GitHub** (*Settings* del repo):
   - En *Environments*, crea el entorno `signing`.
   - En *Secrets and variables → Actions → Variables*, añade estas variables (no son secretos):

   | Variable | Valor |
   |---|---|
   | `AZURE_CLIENT_ID` | ID de aplicación (cliente) de la app de Entra |
   | `AZURE_TENANT_ID` | ID del directorio (inquilino) |
   | `AZURE_SUBSCRIPTION_ID` | Suscripción donde está la cuenta de firma |
   | `AZURE_SIGNING_ENDPOINT` | Endpoint de la cuenta de firma |
   | `AZURE_SIGNING_ACCOUNT` | Nombre de la cuenta de firma |
   | `AZURE_SIGNING_PROFILE` | Nombre del perfil de certificado |

Para probarlo, ejecuta el workflow `release` a mano (*Run workflow*, sin tag). El paso «Verificar firmas (Windows)» falla si queda algún binario sin firma válida.
