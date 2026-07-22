// URL de tu implementación de Google Apps Script
const API_URL =
  "https://script.google.com/macros/s/AKfycbwdd8aVW1WM7wyzxT-JdXjzRp7Fk4qnwVY5xr_ryxQnHKqQGFjIM-4r-dHuMbKqutJB/exec";

let catalogoLocal = [];
let carrito = [];
let clientesLocal = [];
let isSincronizandoVentas = false;
let instanciaActual = localStorage.getItem("instancia") || null;
let turnoActual = JSON.parse(localStorage.getItem("turnoActual")) || null;
let instanciaPendienteLogin = null;

// NUEVO: Diccionario para recordar qué clave pertenece a qué instancia en modo Offline
let credencialesOffline =
  JSON.parse(localStorage.getItem("credencialesOffline")) || {};

// ==========================================
// CONTROL DE PESTAÑAS DUPLICADAS
// ==========================================
const canalTPV = new BroadcastChannel('canal_tpv_sesiones');

// Escuchar si otra pestaña pregunta o afirma estar usando el TPV
canalTPV.onmessage = (evento) => {
    // Si otra pestaña acaba de abrirse y pregunta quién está activo
    if (evento.data.tipo === 'VERIFICAR_ACTIVO' && instanciaActual) {
        canalTPV.postMessage({ tipo: 'SESION_ACTIVA', instancia: instanciaActual });
    }

    // Si nosotros acabamos de preguntar, y alguien responde que ya está activo
    if (evento.data.tipo === 'SESION_ACTIVA' && instanciaActual === evento.data.instancia) {
        document.body.innerHTML = `
            <div style="display:flex; height:100vh; width:100%; justify-content:center; align-items:center; background:var(--bg-color); flex-direction:column; text-align:center; padding: 20px;">
                <h2 style="color:var(--danger-color); margin-bottom:15px;">⚠️ Acceso Bloqueado</h2>
                <p style="font-size:1.1rem;">El terminal <b>${instanciaActual}</b> ya está abierto en otra pestaña o ventana.</p>
                <p style="color:#666; margin-top:10px;">Cierre esta pestaña y continúe trabajando en la ventana original para evitar conflictos en el sistema.</p>
            </div>`;
    }
};



function mostrarLoading(mensaje = "Procesando...") {
  document.getElementById("loading-text").innerText = mensaje;
  document.getElementById("loading-overlay").style.display = "flex";
}

function ocultarLoading() {
  document.getElementById("loading-overlay").style.display = "none";
}

// ==========================================
// DETECCIÓN DE RED Y SINCRONIZACIÓN AUTOMÁTICA
// ==========================================
window.addEventListener("online", manejarEstadoRed);
window.addEventListener("offline", manejarEstadoRed);

function manejarEstadoRed() {
  const statusDiv = document.getElementById("network-status");
  if (navigator.onLine) {
    statusDiv.textContent = "Online - Sincronizando...";
    statusDiv.className = "status-bar online";

    // Sincronizar colas pendientes al recuperar conexión
    sincronizarClientesPendientes().then(() => sincronizarVentasPendientes());
    sincronizarSesionesPendientes();
    sincronizarAbonosPendientes();
    sincronizarEgresos();

    setTimeout(() => (statusDiv.textContent = "Online"), 3000);
  } else {
    statusDiv.textContent = "Offline - Trabajando en local";
    statusDiv.className = "status-bar offline";
  }
}

// ==========================================
// AUTENTICACIÓN
// ==========================================
// ==========================================
// AUTENTICACIÓN (ONLINE / OFFLINE)
// ==========================================
async function iniciarSesion() {
  const clave = document.getElementById("clave-input").value;
  if (!clave) return mostrarToast("Ingrese una clave", "error");

  mostrarLoading("Iniciando sesión...");

  // NUEVO: Generar token de sesión único por navegador
    const tokenSesion = "SES-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("tokenSesion", tokenSesion);
  

  if (navigator.onLine) {
    try {
      const payload = { action: "iniciar_sesion", payload: { clave: clave } };
      const response = await fetch(API_URL, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (data.success) {
        credencialesOffline[clave] = data.data.instancia;
        localStorage.setItem("credencialesOffline", JSON.stringify(credencialesOffline));
        
        // Enviamos la auditoría de caja al modal
        prepararAperturaCaja(data.data.instancia, data.data.ultimoDeclarado, data.data.descuadreAcumulado);
      } else {
        mostrarToast(data.data.error, "error");
      }
    } catch (error) {
      console.warn("Fallo la conexión al servidor. Cambiando a modo offline.", error);
      intentarAccesoOffline(clave);
    } finally {
      ocultarLoading();
    }
  } else {
    intentarAccesoOffline(clave);
    ocultarLoading();
  }
}


// ==========================================
// CONTROL DE COLAS (ENTRADAS / SALIDAS)
// ==========================================
function encolarSesion(tipo, instancia) {
  let sesionesPendientes =
    JSON.parse(localStorage.getItem("sesionesPendientes")) || [];
  sesionesPendientes.push({
    tipo: tipo,
    instancia: instancia,
    fecha: new Date().toISOString(), // Formato ideal para el backend
    token: localStorage.getItem("tokenSesion") // <-- NUEVO: Adjuntar el token
  });
  localStorage.setItem(
    "sesionesPendientes",
    JSON.stringify(sesionesPendientes)
  );
}

async function sincronizarSesionesPendientes() {
  if (!navigator.onLine) return;

  let pendientes = JSON.parse(localStorage.getItem("sesionesPendientes")) || [];
  if (pendientes.length === 0) return;

  try {
    const payload = {
      action: "sincronizar_sesiones",
      payload: { sesiones: pendientes },
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (data.success) {
      // Se limpia la cola del almacenamiento local al confirmar recepción en Google Sheets
      localStorage.removeItem("sesionesPendientes");
      console.log("Registro de sesiones sincronizado con éxito.");
    }
  } catch (error) {
    console.warn(
      "Fallo al sincronizar las entradas/salidas. Se intentará en segundo plano más tarde.",
      error
    );
  }
}

// Verifica si la clave ya fue usada previamente en este dispositivo
function intentarAccesoOffline(clave) {
  console.log("[DEBUG LOGIN] 6. Evaluando acceso Offline. Credenciales guardadas:", credencialesOffline);
  if (credencialesOffline[clave]) {
    if (credencialesOffline[clave]) {
      console.log("[DEBUG LOGIN] 7. Clave encontrada localmente. Instancia:", credencialesOffline[clave]);
      prepararAperturaCaja(credencialesOffline[clave]);
    } else {
      console.warn("[DEBUG LOGIN] Credencial existe pero está vacía o inválida.");
        mostrarToast("Necesita conexión para el primer inicio.","warning");
    }
  } else {
    console.warn("[DEBUG LOGIN] No se encontró la clave localmente para acceso offline.");
    mostrarToast(
      "Necesita conexión a internet para el primer inicio de sesión con esta clave.",
      "warning"
    );
  }
}

function confirmarApertura() {
  console.log("[DEBUG LOGIN] 8. Botón 'Confirmar y Entrar' presionado en modal de apertura.");
    const fondo = parseFloat(document.getElementById('fondo-inicial').value) || 0;
    
    // Inicializamos el objeto del turno
    turnoActual = {
        fondoInicial: fondo,
        ventasEfectivo: 0,
        abonosEfectivo: 0,
        retiros: 0,
        fechaApertura: new Date().toISOString()
    };
    console.log("[DEBUG LOGIN] 9. Guardando turnoActual en localStorage:", turnoActual);
    localStorage.setItem('turnoActual', JSON.stringify(turnoActual));
    
    document.getElementById('modal-apertura').style.display = 'none';
    console.log("[DEBUG LOGIN] 10. Pasando instancia a procesarAcceso:"),
    procesarAcceso(instanciaPendienteLogin); // Ahora sí, entramos al TPV
}

function prepararAperturaCaja(instancia, ultimoDeclaradoBackend = null, descuadreAcumulado = 0) {
  instanciaPendienteLogin = instancia;
  const inputFondo = document.getElementById('fondo-inicial');
  
  if (ultimoDeclaradoBackend !== null) {
      // 1. MODO ONLINE: Arrastre seguro desde la nube
      if (descuadreAcumulado < 0) {
          mostrarToast(`⚠️ ALERTA: Esta TPV tiene un faltante histórico acumulado de $${Math.abs(descuadreAcumulado).toFixed(2)}`, "error");
      } else if (descuadreAcumulado > 0) {
          mostrarToast(`ℹ️ Esta TPV tiene un sobrante histórico acumulado de $${descuadreAcumulado.toFixed(2)}`, "info");
      }
      
      inputFondo.value = parseFloat(ultimoDeclaradoBackend).toFixed(2);
      inputFondo.readOnly = true;
      inputFondo.style.backgroundColor = "#e9ecef"; 
      mostrarToast("Fondo inicial sincronizado con la nube.", "success");
      
  } else {
      // 2. MODO OFFLINE: Confiar temporalmente en el caché local
      const ultimoSaldo = localStorage.getItem(`ultimoSaldoCaja_${instancia}`);
      if (ultimoSaldo !== null) {
          inputFondo.value = parseFloat(ultimoSaldo).toFixed(2);
          mostrarToast("Modo Offline: Apertura basada en el último cierre local.", "warning");
      } else {
          inputFondo.value = "";
      }
      inputFondo.readOnly = false;
      inputFondo.style.backgroundColor = "#ffffff";
  }
  
  document.getElementById('modal-apertura').style.display = 'flex';
}




// Ejecuta la entrada a la interfaz de la TPV
async function procesarAcceso(instancia) {
  console.log("[DEBUG LOGIN] 11. Ejecutando procesarAcceso para la instancia:", instancia);
  instanciaActual = instancia;
  localStorage.setItem("instancia", instanciaActual);
  console.log("[DEBUG LOGIN] 12. Encolando sesión de entrada...");
  // 1. Encolar el registro de "entrada" de manera local
  encolarSesion("entrada", instanciaActual);

  // 2. Transición de UI
  console.log("[DEBUG LOGIN] 13. Ocultando login-screen y mostrando tpv-screen...");
  document.getElementById("login-screen").classList.remove("active");
  document.getElementById("tpv-screen").classList.add("active");
  cargarNombreTPV();
  document.getElementById("instancia-nombre").innerText = instanciaActual;

  // 3. Cargar datos
  console.log("[DEBUG LOGIN] 14. Cargando catálogos, clientes y notificaciones...");
  await cargarCatalogo();
  cargarClientes();
  chequearNotificacionesSilencioso();

  // 4. Intentar enviar la sesión a Google Sheets inmediatamente (si hay red)
  console.log("[DEBUG LOGIN] 15. Proceso finalizado. Intentando sincronizar sesiones...");
  sincronizarSesionesPendientes();
}

// ==========================================
// CERRAR SESIÓN (OFFLINE-FRIENDLY)
// ==========================================
function cerrarSesion() {
    limpiarContadorBilletes(); // Forzamos limpiar el contador y el total
    document.getElementById('efectivo-declarado').value = '';
    document.getElementById('modal-cierre').style.display = 'flex';
}

async function ejecutarCierreCaja() {
  // RESTRICCIÓN DE SEGURIDAD: Prohibido cerrar turno sin conexión
  if (!navigator.onLine) {
      return mostrarToast("El cierre de caja requiere conexión a internet", "error");
  }

  const declarado = parseFloat(document.getElementById('efectivo-declarado').value);
  if (isNaN(declarado) || declarado < 0) return mostrarToast("Ingrese un monto válido", "error");

  if (!turnoActual) {
      mostrarToast("Error: No se detectó un turno activo. Reinicie la aplicación.", "error");
      cerrarModal('modal-cierre');
      return;
  }

  const teorico = (turnoActual.fondoInicial + turnoActual.ventasEfectivo + turnoActual.abonosEfectivo) - turnoActual.retiros;
  const diferencia = declarado - teorico;

  // 1. Armamos el objeto de reporte ANTES de validar la diferencia
  const reporteCierre = {
      tpv: instanciaActual,
      fechaApertura: turnoActual.fechaApertura,
      fechaCierre: new Date().toISOString(),
      fondoInicial: turnoActual.fondoInicial,
      teorico: teorico,
      declarado: declarado,
      diferencia: diferencia,
      retirosTotales: turnoActual.retiros,
      estado: diferencia === 0 ? "cuadrado" : "descuadre" // <-- NUEVA PROPIEDAD
  };

  // 2. NUEVA VALIDACIÓN: SI HAY DESCUADRE, REGISTRA EL INTENTO Y BLOQUEA
  if (diferencia !== 0) {
      const tipoDescuadre = diferencia > 0 ? "sobrante" : "faltante";
      
      mostrarLoading('Registrando intento fallido por descuadre...');
      try {
          // Enviamos el reporte a la hoja de cálculo
          const payloadIntento = {
              action: 'registrar_cierre_caja',
              payload: { cierres: [reporteCierre] }
          };
          console.log("Descuadre");
          await fetch(API_URL, {
              method: "POST",
              body: JSON.stringify(payloadIntento),
          });
      } catch (error) {
          console.warn("No se pudo registrar el intento en la nube", error);
      } finally {
          ocultarLoading();
      }

      return mostrarToast(`No se puede cerrar. Hay un ${tipoDescuadre} de $${Math.abs(diferencia).toFixed(2)}. El incidente fue registrado.`, "error");
  }

  // 3. FLUJO NORMAL (CUADRADO)
  mostrarLoading('Auditando y sincronizando...');

  try {
      // Forzar la subida de todas las operaciones locales antes de procesar el cierre
      await sincronizarClientesPendientes();
      await sincronizarVentasPendientes();
      await sincronizarAbonosPendientes();
      await sincronizarEgresos();

      // Enviar el cierre definitivamente a la API
      const payload = {
          action: 'registrar_cierre_caja',
          payload: { cierres: [reporteCierre] }
      };
      const response = await fetch(API_URL, {
          method: "POST",
          body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (data.success) {
          mostrarToast(`Cierre procesado sin descuadres.`, "success");

          // Limpieza estricta de la UI y Sesión
          cerrarModal('modal-cierre');
          encolarSesion('salida', instanciaActual); 
          await sincronizarSesionesPendientes(); // Subir la salida de inmediato
          
          // Actualizamos la caché local por si abren mañana sin red
          localStorage.setItem(`ultimoSaldoCaja_${instanciaActual}`, declarado);
          
          instanciaActual = null;
          turnoActual = null;
          carrito = [];
          localStorage.removeItem('instancia');
          localStorage.removeItem('turnoActual');
          localStorage.removeItem('tokenSesion');

          document.getElementById('tpv-screen').classList.remove('active');
          document.getElementById('login-screen').classList.add('active');

          setTimeout(() => {
              generarTicketCierre(reporteCierre);
          }, 300);
      } else {
          mostrarToast("El servidor rechazó el cierre. Intente nuevamente.", "error");
      }
  } catch (error) {
      mostrarToast("Error de conexión. Revise su internet para poder finalizar el turno.", "error");
  } finally {
      ocultarLoading();
  }
}





// Generador del Ticket 58mm/80mm (Texto para imprimir)
function generarTicketCierre(reporte) {
  let ventanaImpresion = window.open('', '_blank');
  
  // Validación de seguridad por si el navegador bloquea el pop-up
  if (!ventanaImpresion) {
      mostrarToast("Ticket no generado: Desactive el bloqueador de ventanas emergentes.", "warning");
      return; 
  }

  let html = `
      <div style="font-family: monospace; width: 300px; text-align: center;">
          <h2>REPORTE Z - CIERRE</h2>
          <p><strong>TPV:</strong> ${reporte.tpv}</p>
          <p><strong>Fecha:</strong> ${new Date(reporte.fechaCierre).toLocaleString()}</p>
          <hr style="border-top: 1px dashed black;">
          <div style="text-align: left;">
              <p>Fondo Inicial: $${reporte.fondoInicial.toFixed(2)}</p>
              <p>Retiros/Egresos: -$${reporte.retirosTotales.toFixed(2)}</p>
              <p><strong>Efectivo Teórico: $${reporte.teorico.toFixed(2)}</strong></p>
              <hr style="border-top: 1px dashed black;">
              <p>Efectivo Físico (Declarado): $${reporte.declarado.toFixed(2)}</p>
              <p><strong>Diferencia: $${reporte.diferencia.toFixed(2)}</strong></p>
          </div>
          <br><br><br>
          <p>_________________________</p>
          <p>Firma Cajero</p>
      </div>
      <script>window.print(); window.close();</script>
  `;
  ventanaImpresion.document.write(html);
  ventanaImpresion.document.close();
}



// ==========================================
// CATÁLOGO Y CARRITO
// ==========================================
// ==========================================
// CATÁLOGO Y CARRITO (Actualizado)
// ==========================================
// ==========================================
// CATÁLOGO Y CARRITO (Corregido para tu Backend)
// ==========================================
async function cargarCatalogo() {
  if (navigator.onLine) {
    mostrarLoading("Cargando catalogo...");

    try {
      // Descargar desde Apps Script
      const payload = {
        action: "obtener_catalogo",
        payload: { instancia: instanciaActual },
      };
      const response = await fetch(API_URL, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (data.success) {
        // Tu backend ya envía los datos formateados correctamente (id, nombre, precio, existencia)
        catalogoLocal = data.data;
        // Guardar catálogo para modo offline
        localStorage.setItem("catalogoLocal", JSON.stringify(catalogoLocal));
      } else {
        console.warn(
          "El servidor respondió con error al pedir el catálogo:",
          data
        );
        mostrarToast("Error del servidor: " + data.data.error, "error");
      }
    } catch (error) {
      console.error("Error de conexión al cargar catálogo:", error);
    } finally {
      ocultarLoading(); // <-- OCULTAR SPINNER SIEMPRE
    }
  } else {
    // Leer de almacenamiento local si estamos offline
    const guardado = localStorage.getItem("catalogoLocal");
    if (guardado) catalogoLocal = JSON.parse(guardado);
  }

  renderizarCatalogo();
}

async function cargarClientes() {
  if (navigator.onLine) {
    try {
      const payload = { action: "obtener_clientes", payload: {} };
      const response = await fetch(API_URL, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (data.success) {
        clientesLocal = data.data;
        localStorage.setItem("clientesLocal", JSON.stringify(clientesLocal));
      }
    } catch (error) {
      console.error("Error cargando clientes", error);
    }
  } else {
    const guardado = localStorage.getItem("clientesLocal");
    if (guardado) clientesLocal = JSON.parse(guardado);
  }
  renderizarListaClientes();
}
// ==========================================
// BUSCADOR DE PRODUCTOS (Faltante)
// ==========================================
function filtrarCatalogo() {
  const textoBusqueda = normalizarTexto(
    document.getElementById("buscar-producto").value
  );

  // Filtramos sobre el array local en vez de ocultar nodos del DOM manualmente
  const catalogoFiltrado = catalogoLocal.filter((prod) => {
    const nombreNorm = normalizarTexto(prod.nombre);
    const divisionNorm = normalizarTexto(prod.division); // Permite buscar también por categoría

    return (
      nombreNorm.includes(textoBusqueda) || divisionNorm.includes(textoBusqueda)
    );
  });

  renderizarCatalogo(catalogoFiltrado);
}

function renderizarCatalogo(productosFiltrados = catalogoLocal) {
  const contenedor = document.getElementById("catalogo-container");
  contenedor.innerHTML = "";

  productosFiltrados.forEach((prod) => {
    // Buscar si el producto ya está en el carrito para conocer su cantidad actual
    const itemEnCarrito = carrito.find(
      (item) => String(item.id) === String(prod.id)
    );
    const cantidadAgregada = itemEnCarrito ? itemEnCarrito.cantidad : 0;

    // Determinar estados críticos de stock
    const esAgotado = prod.existencia <= 0;
    const esBajoStock =
      prod.existencia > 0 && prod.existencia <= (prod.stock_minimo || 5);

    const btn = document.createElement("div");
    // Asignación de clases dinámicas según el estado
    btn.className = `producto-item ${esAgotado ? "agotado" : ""} ${
      esBajoStock ? "bajo-stock" : ""
    }`;

    btn.innerHTML = `
            <div class="producto-cuerpo">
                <strong>${prod.nombre}</strong><br>
                <span class="producto-precio">$${prod.precio}</span> 
                <span class="producto-separador">|</span> 
                <span class="producto-stock">Stock: ${prod.existencia}</span>
            </div>
            ${
              cantidadAgregada > 0
                ? `<span class="badge-cantidad-carrito">${cantidadAgregada}</span>`
                : ""
            }
            ${
              esAgotado
                ? `<span class="badge-status-agotado">Agotado</span>`
                : ""
            }
            ${
              esBajoStock && cantidadAgregada === 0
                ? `<span class="badge-status-bajo">¡Últimas!</span>`
                : ""
            }
        `;

    if (esAgotado) {
      btn.style.cursor = "not-allowed";
    } else {
      btn.onclick = () => {
        agregarAlCarrito(prod);
        // Volvemos a renderizar la lista filtrada actual para actualizar los contadores al instante
        renderizarCatalogo(productosFiltrados);
      };
    }
    contenedor.appendChild(btn);
  });
}

function agregarAlCarrito(producto) {
  // Validar existencia localmente
  const indexCat = catalogoLocal.findIndex((p) => p.id === producto.id);
  if (catalogoLocal[indexCat].existencia <= 0)
    return mostrarToast("Producto agotado", "error");

  const itemExistente = carrito.find((item) => item.id === producto.id);
  if (itemExistente) {
    if (catalogoLocal[indexCat].existencia > itemExistente.cantidad) {
      itemExistente.cantidad++;
    } else {
      mostrarToast("No hay más stock disponible para este producto", "warning");
    }
  } else {
    carrito.push({ ...producto, cantidad: 1 });
  }
  renderizarCarrito();
}

function agregarAlCarritoPorId(id) {
  // Convertimos ambos a String (texto) para asegurar que la comparación funcione
  const producto = catalogoLocal.find((p) => String(p.id) === String(id));
  if (producto) {
    agregarAlCarrito(producto);
  }
}

function eliminarDelCarrito(id) {
  // Filtramos convirtiendo a String
  carrito = carrito.filter((item) => String(item.id) !== String(id));
  renderizarCarrito();
}

function restarDelCarrito(id) {
  // Buscamos el índice usando String
  const itemIndex = carrito.findIndex((item) => String(item.id) === String(id));
  if (itemIndex !== -1) {
    if (carrito[itemIndex].cantidad > 1) {
      // Si hay más de 1, restamos la cantidad
      carrito[itemIndex].cantidad--;
    } else {
      // Si la cantidad es 1 y restamos, lo eliminamos completamente
      carrito.splice(itemIndex, 1);
    }
    renderizarCarrito();
  }
}

function renderizarCarrito() {
  const lista = document.getElementById("lista-carrito");
  lista.innerHTML = "";
  let total = 0;

  carrito.forEach((item) => {
    const subtotal = item.precio * item.cantidad;
    total += subtotal;
    lista.innerHTML += `
            <li>
                <div class="item-info">
                    ${item.nombre} <br>
                    <small>$${item.precio} c/u</small>
                </div>
                <div class="item-controles">
                    <button class="btn-restar" onclick="restarDelCarrito('${
                      item.id
                    }')">-</button>
                    <span class="item-cantidad">${item.cantidad}</span>
                    <button class="btn-sumar" onclick="agregarAlCarritoPorId('${
                      item.id
                    }')">+</button>
                    <div class="item-subtotal">$${subtotal.toFixed(2)}</div>
                    <button class="btn-eliminar" onclick="eliminarDelCarrito('${
                      item.id
                    }')">X</button>
                </div>
            </li>
        `;
  });

  document.getElementById("total-importe").innerText = total.toFixed(2);
  calcularVuelto();
  // NUEVO: Habilitar/Deshabilitar el botón de cobro
  const btnCobrar = document.getElementById("btn-cobrar");
  if (total > 0) {
    btnCobrar.disabled = false;
  } else {
    btnCobrar.disabled = true;
  }
}

// ==========================================
// CONTROL DE MÉTODO DE PAGO
// ==========================================
function toggleReferencia() {
  const metodo = document.getElementById("metodo-pago").value;
  const inputRef = document.getElementById("ref-pago-movil");
  const seccionCredito = document.getElementById("seccion-credito");
  const seccionVuelto = document.getElementById("seccion-vuelto");

  inputRef.style.display = "none";
  seccionCredito.style.display = "none";
  seccionVuelto.style.display = "block";

  if (metodo === "pago_movil") {
    inputRef.style.display = "block";
    inputRef.focus();
  } else if (metodo === "credito") {
    seccionCredito.style.display = "block";
    seccionVuelto.style.display = "none"; // No hay vuelto en crédito
    document.getElementById("monto-pagado").value = "";
  }
}

// ==========================================
// CÁLCULO DE VUELTO
// ==========================================
function calcularVuelto() {
  const totalTexto = document.getElementById("total-importe").innerText;
  const total = parseFloat(totalTexto) || 0;

  const inputPagado = document.getElementById("monto-pagado").value;
  const pagado = parseFloat(inputPagado) || 0;

  const vuelto = pagado - total;
  const spanVuelto = document.getElementById("vuelto-importe");

  // Si no han escrito nada o es 0
  if (pagado === 0 || inputPagado === "") {
    spanVuelto.innerText = "$0.00";
    spanVuelto.style.color = "var(--primary-color)";
  } else if (vuelto < 0) {
    // Si falta dinero
    spanVuelto.innerText = `Faltan $${Math.abs(vuelto).toFixed(2)}`;
    spanVuelto.style.color = "var(--danger-color)";
  } else {
    // Vuelto a entregar
    spanVuelto.innerText = `$${vuelto.toFixed(2)}`;
    spanVuelto.style.color = "var(--success-color)";
  }
}

// ==========================================
// MÓDULO DE TRANSFERENCIAS E INVENTARIO
// ==========================================

function abrirModalTransferencia() {
  if (!navigator.onLine)
    return mostrarToast(
      "Necesitas conexión a internet para hacer transferencias.",
      "warning"
    );

  const select = document.getElementById("trans-producto");
  select.innerHTML = "";

  // Poblar productos con stock local
  catalogoLocal.forEach((p) => {
    if (p.existencia > 0) {
      const option = document.createElement("option");
      option.value = p.nombre;
      option.textContent = `${p.nombre} (Disp: ${p.existencia})`;
      select.appendChild(option);
    }
  });

  document.getElementById("modal-transferencia").style.display = "flex";
}

function cerrarModal(id) {
  document.getElementById(id).style.display = "none";
}

async function ejecutarTransferencia() {
  const producto = document.getElementById("trans-producto").value;
  const cantidad = parseInt(document.getElementById("trans-cantidad").value);
  const destino = document.getElementById("trans-destino").value;

  if (!cantidad || cantidad <= 0)
    return mostrarToast("Ingrese una cantidad válida.", "error");
  if (destino === instanciaActual)
    return mostrarToast("No puedes transferir a tu propia instancia.", "error");

  mostrarLoading("Realizando trasferencia...");

  try {
    const payload = {
      action: "crear_movimiento",
      payload: { origen: instanciaActual, destino, producto, cantidad },
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (data.success) {
      mostrarToast(data.data.mensaje, "success");
      cerrarModal("modal-transferencia");
      await cargarCatalogo(); // Recargar para actualizar stock descontado
    } else {
      mostrarToast("Error: " + data.data.error, "error");
    }
  } catch (error) {
    mostrarToast("Error de conexión al procesar la transferencia.", "error");
  } finally {
    ocultarLoading(); // <-- OCULTAR SPINNER SIEMPRE
  }
}

// ==========================================
// MÓDULO DE NOTIFICACIONES
// ==========================================

async function verificarNotificaciones() {
  if (!navigator.onLine)
    return mostrarToast(
      "Necesitas conexión para ver notificaciones en tiempo real.",
      "warning"
    );

  try {
    const payload = {
      action: "revisar_notificaciones",
      payload: { instancia: instanciaActual },
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (data.success) {
      // CORRECCIÓN: Acceder específicamente al arreglo 'transferencias' dentro del objeto devuelto
      mostrarNotificaciones(data.data.transferencias);
    }
  } catch (error) {
    console.error("Error al buscar notificaciones:", error);
  }
}

function mostrarNotificaciones(notificaciones) {
  const lista = document.getElementById("lista-notificaciones");
  const badge = document.getElementById("badge-notificaciones");
  lista.innerHTML = "";

  if (notificaciones.length === 0) {
    lista.innerHTML = "<li>No hay transferencias pendientes.</li>";
    badge.style.display = "none";
  } else {
    badge.style.display = "inline";
    badge.textContent = notificaciones.length;

    notificaciones.forEach((notif) => {
      lista.innerHTML += `
                <li style="padding: 10px; border-bottom: 1px solid #ddd; margin-bottom: 10px;">
                    <strong>De: ${notif.origen}</strong><br>
                    Producto: ${notif.producto} (Cant: ${notif.cantidad})<br>
                    <small>Existencia final quedará en: ${notif.existenciaProyectada}</small><br>
                    <input type="password" id="firma-${notif.idFila}" placeholder="Firma digital" style="margin-top:5px; padding:5px; width:100%; border:1px solid #ccc;">
                    <button onclick="aprobarTransferencia(${notif.idFila})" style="margin-top: 5px; background-color: var(--success-color); width: 100%;">Aprobar Recepción</button>
                </li>
            `;
    });
  }

  document.getElementById("modal-notificaciones").style.display = "block";
}

// Función que revisa en segundo plano sin interrumpir al usuario
async function chequearNotificacionesSilencioso() {
  // Si no hay internet o no ha iniciado sesión, no hacemos nada
  if (!navigator.onLine || !instanciaActual) return;

  try {
    const payload = {
      action: "revisar_notificaciones",
      payload: { instancia: instanciaActual },
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (data.success) {
      const badge = document.getElementById("badge-notificaciones");
      const botonNotif = badge.parentElement;

      // CORRECCIÓN: Medir la longitud del arreglo 'transferencias'
      const cantidad = data.data.transferencias.length;

      if (cantidad > 0) {
        // Hay pendientes: mostrar badge rojo y animar el botón
        badge.style.display = "inline-block";
        badge.textContent = cantidad;
        botonNotif.classList.add("boton-alerta");
      } else {
        // No hay pendientes: ocultar badge y quitar animación
        badge.style.display = "none";
        botonNotif.classList.remove("boton-alerta");
      }
    }
  } catch (error) {
    console.warn("Fallo silencioso al buscar notificaciones:", error);
  }
}

async function aprobarTransferencia(idFila) {
  const firma = document.getElementById(`firma-${idFila}`).value;
  if (!firma)
    return mostrarToast(
      "Debes ingresar tu firma digital para aprobar el movimiento.",
      "error"
    );

  mostrarLoading("Aprobando transferencia...");

  try {
    const payload = {
      action: "aprobar_movimiento",
      payload: {
        idFila: idFila,
        instancia: instanciaActual,
        firma: btoa(firma),
      }, // btoa codifica levemente la firma base64
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (data.success) {
      mostrarToast("Transferencia recibida con éxito.", "success");
      cerrarModal("modal-notificaciones");
      await cargarCatalogo(); // Recargar catálogo para ver las nuevas existencias
      chequearNotificacionesSilencioso();
    } else {
      mostrarToast("Error al aprobar: " + data.data.error, "warning");
    }
  } catch (error) {
    mostrarToast("Error de conexión al aprobar la transferencia.", "error");
  } finally {
    ocultarLoading(); // <-- OCULTAR SPINNER SIEMPRE
  }
}

// Llama a verificarNotificaciones() silenciosamente al cargar el catálogo o al iniciar sesión
// Puedes agregar 'verificarNotificaciones();' al final de la función cargarCatalogo() en tu código original.

// ==========================================
// PROCESAMIENTO Y MODO OFFLINE (EL CORE)
// ==========================================
function procesarVenta() {
  if (carrito.length === 0)
    return mostrarToast("El carrito está vacío", "warning");

  const metodoPago = document.getElementById("metodo-pago").value;
  const refPagoMovil = document.getElementById("ref-pago-movil").value.trim();
  const totalTicket = parseFloat(
    document.getElementById("total-importe").innerText
  );

  let montoPagado = totalTicket;
  let vueltoTotal = 0;
  let clienteId = null;
  let nombreCliente = "";

  if (metodoPago !== "credito") {
    const inputPagado = document.getElementById("monto-pagado").value;
    montoPagado = parseFloat(inputPagado);
    if (isNaN(montoPagado) || inputPagado === "") montoPagado = totalTicket;
    vueltoTotal = montoPagado - totalTicket;

    if (metodoPago === "pago_movil" && refPagoMovil === "")
      return mostrarToast("Ingrese número de referencia.", "warning");
    if (vueltoTotal < 0) return mostrarToast("Faltan fondos.", "error");
  } else {
    // LÓGICA DE CRÉDITO
    nombreCliente = document.getElementById("cliente-credito").value.trim();
    if (nombreCliente === "")
      return mostrarToast(
        "Debe seleccionar o crear un cliente para dar crédito.",
        "warning"
      );

    montoPagado = 0; // En crédito, no entra dinero en caja
    vueltoTotal = 0;

    let clienteObj = clientesLocal.find(
      (c) => c.nombre.toLowerCase() === nombreCliente.toLowerCase()
    );

    if (clienteObj) {
      // Validar límite
      if (Number(clienteObj.deuda) + totalTicket > clienteObj.limite) {
        return mostrarToast(
          "Esta venta excede el límite de crédito del cliente.",
          "error"
        );
      }
      clienteObj.deuda = Number(clienteObj.deuda) + totalTicket;
      clienteId = clienteObj.id;
    } else {
      // Crear cliente nuevo offline
      const nuevoLimite = parseFloat(
        document.getElementById("nuevo-limite").value
      );
      const nuevoTel = document.getElementById("nuevo-telefono").value;

      if (isNaN(nuevoLimite) || nuevoLimite < totalTicket)
        return mostrarToast(
          "Ingrese un límite de crédito válido y mayor al ticket actual.",
          "error"
        );

      clienteId = "CLI-" + Date.now();
      clienteObj = {
        id: clienteId,
        nombre: nombreCliente,
        telefono: nuevoTel,
        limite: nuevoLimite,
        deuda: totalTicket,
      };

      clientesLocal.push(clienteObj);

      // Encolar cliente para sincronización
      let clientesPendientes =
        JSON.parse(localStorage.getItem("clientesPendientes")) || [];
      // TRUCO: Enviamos el cliente a la nube con deuda 0. La deuda real se sumará cuando se procesen sus ventas.
      clientesPendientes.push({ ...clienteObj, deuda: 0 });
      localStorage.setItem(
        "clientesPendientes",
        JSON.stringify(clientesPendientes)
      );
    }
    localStorage.setItem("clientesLocal", JSON.stringify(clientesLocal));
  }

  const ventasGeneradas = [];
  const fechaActual = new Date().toLocaleDateString("es-ES");
  const idVenta = "V-" + Date.now();

  carrito.forEach((item) => {
    const importeItem = item.precio * item.cantidad;
    const inversionAcumulado = (item.inversion || 0) * item.cantidad;

    ventasGeneradas.push({
      ID_Venta: idVenta,
      Fecha: fechaActual,
      TPV: instanciaActual,
      Producto: item.nombre,
      Cantidad: item.cantidad,
      Importe: importeItem,
      Pagado: montoPagado,
      Vuelto: vueltoTotal,
      Metodo_pago: metodoPago,
      Ref_pago_movil: refPagoMovil,
      inversion: inversionAcumulado,
      Cliente_Credito: clienteId || "",
    });

    const indexCat = catalogoLocal.findIndex(
      (p) => String(p.id) === String(item.id)
    );
    if (indexCat !== -1) catalogoLocal[indexCat].existencia -= item.cantidad;
  });

  localStorage.setItem("catalogoLocal", JSON.stringify(catalogoLocal));
  if (navigator.onLine) {
    // Sincronizamos clientes PRIMERO, y cuando termine, encolamos y sincronizamos las ventas
    sincronizarClientesPendientes().then(() => {
      encolarVentas(ventasGeneradas);
    });
  } else {
    // Si estamos offline, solo encolamos (se sincronizará después)
    encolarVentas(ventasGeneradas);
  }

  // Validación de seguridad: Solo sumamos si el turno actual fue creado exitosamente
  if (metodoPago === 'efectivo' && turnoActual) {
    turnoActual.ventasEfectivo += (montoPagado - vueltoTotal); 
    localStorage.setItem('turnoActual', JSON.stringify(turnoActual));
  }

    // --- NUEVO: Leer el estado del CheckBox ---
    const imprimirTicket = document.getElementById("chk-generar-ticket").checked;

    if (imprimirTicket) {
        // Clonamos el carrito [...carrito] antes de que se limpie en la línea de abajo
        generarTicketVenta(idVenta, [...carrito], totalTicket, montoPagado, vueltoTotal, metodoPago, nombreCliente || "");
    }
  
  // Limpiar UI
  carrito = [];
  document.getElementById("metodo-pago").value = "efectivo";
  document.getElementById("monto-pagado").value = "";
  document.getElementById("cliente-credito").value = "";
  document.getElementById("nuevo-limite").value = "";
  document.getElementById("nuevo-telefono").value = "";
  
  // NUEVO: Limpiar la referencia de pago móvil que se quedaba trabada
  document.getElementById("ref-pago-movil").value = ""; 
  
  // NUEVO: Ocultar los badges informativos del módulo de crédito
  document.getElementById("estado-deuda").style.display = "none";
  document.getElementById("nuevo-cliente-campos").style.display = "none";

  toggleReferencia();
  renderizarCarrito();
  renderizarCatalogo();

  mostrarToast(`Venta ${idVenta} registrada correctamente.`, "success");
}


function encolarVentas(nuevasVentas) {
  let colaPendientes =
    JSON.parse(localStorage.getItem("ventasPendientes")) || [];
  colaPendientes = colaPendientes.concat(nuevasVentas);
  localStorage.setItem("ventasPendientes", JSON.stringify(colaPendientes));

  // Si hay internet, intentar sincronizar inmediatamente
  if (navigator.onLine) {
    sincronizarVentasPendientes();
  }
}

async function sincronizarVentasPendientes() {
  if (isSincronizandoVentas) return; // Candado: Evita dobles envíos

  let colaPendientes =
    JSON.parse(localStorage.getItem("ventasPendientes")) || [];
  if (colaPendientes.length === 0) return;

  isSincronizandoVentas = true;
  mostrarLoading("Sincronizando ventas...");

  try {
    const payload = {
      action: "sincronizar_ventas",
      payload: { ventas: colaPendientes },
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (data.success) {
      // En lugar de borrar TODA la cola de golpe (lo que perdería ventas hechas en offline mientras cargaba),
      // solo eliminamos de la cola la cantidad de ventas que acabamos de enviar exitosamente.
      let colaActual =
        JSON.parse(localStorage.getItem("ventasPendientes")) || [];
      let colaRestante = colaActual.slice(colaPendientes.length);
      localStorage.setItem("ventasPendientes", JSON.stringify(colaRestante));
      console.log("Sincronización de ventas exitosa");
    }
  } catch (error) {
    console.warn("Fallo al sincronizar ventas. Se intentará más tarde.", error);
  } finally {
    isSincronizandoVentas = false; // Liberamos el candado
    ocultarLoading();
  }
}

// Inicialización de la App
window.onload = async () => {
  manejarEstadoRed();
  if (instanciaActual) {
    const tokenLocal = localStorage.getItem("tokenSesion");

    // Verificar en la nube si este navegador tiene el token válido
    if (navigator.onLine) {
      mostrarLoading("Verificando sesión...");
      try {
        const payload = { 
            action: "verificar_sesion", 
            payload: { instancia: instanciaActual, token: tokenLocal } 
        };
        const response = await fetch(API_URL, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const data = await response.json();

        // Si la sesión es inválida o fue abierta en otro lado, bloquear el acceso
        if (!data.success) {
          mostrarToast(data.data.error || "Sesión cerrada o activa en otro navegador.", "error");
          forzarCierreLocal();
          ocultarLoading();
          return; 
        }
      } catch (error) {
        console.warn("Error de conexión al verificar sesión. Operando con caché local.");
      }
      ocultarLoading();
    }

    iniciarEntornoTPV();
  }

  setInterval(chequearNotificacionesSilencioso, 60000);
};

// Función auxiliar para cargar el entorno gráfico
function iniciarEntornoTPV() {
  canalTPV.postMessage({ tipo: 'VERIFICAR_ACTIVO', instancia: instanciaActual });
  document.getElementById("login-screen").classList.remove("active");
  document.getElementById("tpv-screen").classList.add("active");
  cargarNombreTPV();
  document.getElementById("instancia-nombre").innerText = instanciaActual;

  cargarCatalogo();
  cargarClientes();
  sincronizarClientesPendientes().then(() => sincronizarVentasPendientes());
  sincronizarSesionesPendientes(); 
  sincronizarAbonosPendientes();
  sincronizarEgresos();
  chequearNotificacionesSilencioso();
}

// Función auxiliar para expulsar al usuario intruso
function forzarCierreLocal() {
  instanciaActual = null;
  turnoActual = null;
  localStorage.removeItem("instancia");
  localStorage.removeItem("turnoActual");
  localStorage.removeItem("tokenSesion");
  document.getElementById("tpv-screen").classList.remove("active");
  document.getElementById("login-screen").classList.add("active");
}


// ==========================================
// MÓDULO DE DASHBOARD Y MÉTRICAS
// ==========================================
async function abrirDashboard() {
  if (!instanciaActual)
    return mostrarToast("Debe iniciar sesión primero.", "warning");

  document.getElementById("dash-instancia").innerText = instanciaActual;
  document.getElementById("modal-dashboard").style.display = "block";

  // Poblar el selector de productos con el catálogo actual
  const selectProducto = document.getElementById("dash-producto");
  selectProducto.innerHTML = '<option value="">Todos los productos</option>'; // Resetear
  catalogoLocal.forEach((p) => {
    const option = document.createElement("option");
    option.value = p.nombre;
    option.textContent = p.nombre;
    selectProducto.appendChild(option);
  });

  // Establecer fechas por defecto (Desde el primer día del mes actual hasta hoy)
  const hoy = new Date();
  const primerDiaMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

  document.getElementById("dash-fecha-inicio").value = primerDiaMes
    .toISOString()
    .split("T")[0];
  document.getElementById("dash-fecha-fin").value = hoy
    .toISOString()
    .split("T")[0];
  document.getElementById("dash-producto").value = ""; // Por defecto: Todos

  // Cargar métricas iniciales
  await cargarMetricasDashboard();

  // Cargar datos locales secundarios (Termómetro de colas e inventario)
  cargarDatosSecundariosDashboard();
}

async function cargarMetricasDashboard() {
  const fInicio = document.getElementById("dash-fecha-inicio").value;
  const fFin = document.getElementById("dash-fecha-fin").value;
  const productoSel = document.getElementById("dash-producto").value; // NUEVO: Capturar producto
  const indicador = document.getElementById("dash-modo-indicador");

  if (navigator.onLine) {
    indicador.innerText = "(Modo Online: Datos Históricos en la Nube)";
    indicador.style.color = "var(--success-color)";
    document.getElementById("dash-fecha-inicio").disabled = false;
    document.getElementById("dash-fecha-fin").disabled = false;

    mostrarLoading("Calculando métricas en la nube...");
    try {
      const payload = {
        action: "obtener_metricas",
        // NUEVO: Enviamos el producto al backend
        payload: {
          fechaInicio: fInicio,
          fechaFin: fFin,
          instancia: instanciaActual,
          producto: productoSel,
        },
      };
      const response = await fetch(API_URL, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (data.success) {
        renderizarMetricas(data.data);
      } else {
        mostrarToast("Error del servidor: " + data.data.error, "error");
      }
    } catch (error) {
      console.warn(
        "Fallo la conexión. Cambiando a vista offline local.",
        error
      );
      calcularMetricasOffline();
    } finally {
      ocultarLoading();
    }
  } else {
    indicador.innerText = "(Modo Offline: Datos del periodo sin conexión)";
    indicador.style.color = "var(--danger-color)";
    document.getElementById("dash-fecha-inicio").disabled = true;
    document.getElementById("dash-fecha-fin").disabled = true;

    calcularMetricasOffline();
  }
}

function calcularMetricasOffline() {
  let ventasPendientes =
    JSON.parse(localStorage.getItem("ventasPendientes")) || [];
  const productoSel = document.getElementById("dash-producto").value;

  let cantidadVentas = new Set();
  let cantProductos = 0;
  let importePagado = 0;
  let importeCredito = 0;
  let inversion = 0;
  let fechasUnicas = new Set();
  let desgloseProductosMap = {};

  ventasPendientes.forEach((venta) => {
    if (productoSel !== "" && venta.Producto !== productoSel) return;

    cantidadVentas.add(venta.ID_Venta);
    cantProductos += venta.Cantidad || 0;
    inversion += venta.inversion || 0;
    fechasUnicas.add(venta.Fecha);

    // Separar crédito de efectivo/transferencia
    if (venta.Metodo_pago === "credito") {
      importeCredito += venta.Importe || 0;
    } else {
      importePagado += venta.Importe || 0;
    }

    // Agrupar desglose de productos offline
    if (!desgloseProductosMap[venta.Producto]) {
      desgloseProductosMap[venta.Producto] = { cantidad: 0, importe: 0 };
    }
    desgloseProductosMap[venta.Producto].cantidad += venta.Cantidad || 0;
    desgloseProductosMap[venta.Producto].importe += venta.Importe || 0;
  });

  // Calcular deuda total de la base local
  let deudaTotalLocal = 0;
  clientesLocal.forEach((cliente) => {
    deudaTotalLocal += parseFloat(cliente.deuda) || 0;
  });

  const importeTotalContable = importePagado + importeCredito;
  const ganancia = importeTotalContable - inversion;
  const diasVenta = fechasUnicas.size || 1;

  // NUEVO: Generar listado offline aproximado usando la cache local
  let deudoresLocal = [];
  clientesLocal.forEach((cliente) => {
    if (parseFloat(cliente.deuda) > 0) {
      let productosSet = new Set();
      let fechaAntigua = new Date();
      let tieneVentasPendientes = false;

      ventasPendientes.forEach((v) => {
        if (v.Metodo_pago === "credito" && v.Cliente_Credito === cliente.id) {
          productosSet.add(v.Producto);
          let f = new Date(v.Fecha.split("/").reverse().join("-"));
          if (f < fechaAntigua) fechaAntigua = f;
          tieneVentasPendientes = true;
        }
      });

      let dias = tieneVentasPendientes
        ? Math.floor((new Date() - fechaAntigua) / (1000 * 60 * 60 * 24))
        : "N/D (Modo Offline)";

      deudoresLocal.push({
        nombre: cliente.nombre,
        telefono: cliente.telefono || "N/A",
        deuda: parseFloat(cliente.deuda),
        productos:
          productosSet.size > 0
            ? Array.from(productosSet).join(", ")
            : "Histórico en Nube",
        dias_pendientes: dias,
      });
    }
  });

  let abonosPendientes =
    JSON.parse(localStorage.getItem("abonosPendientes")) || [];
  let abonosPeriodoOffline = 0;
  abonosPendientes.forEach((abono) => {
    abonosPeriodoOffline += parseFloat(abono.monto) || 0;
  });

  let listadoProductosVendidos = [];
  for (let prod in desgloseProductosMap) {
    listadoProductosVendidos.push({
      nombre: prod,
      cantidad: desgloseProductosMap[prod].cantidad,
      importe: desgloseProductosMap[prod].importe,
    });
  }
  listadoProductosVendidos.sort((a, b) => b.cantidad - a.cantidad);

  const metricasLocales = {
    cantidad_ventas: cantidadVentas.size,
    cant_productos_vendidos: cantProductos,
    importe_pagado: importePagado,
    importe_credito: importeCredito,
    dias_de_venta: fechasUnicas.size,
    inversion: inversion,
    ganancia: ganancia,
    deuda_total: deudaTotalLocal,
    abonos_periodo: 0, // En offline puro, los abonos no se guardan en caché actualmente
    listado_deudores: deudoresLocal,
    desglose_productos: listadoProductosVendidos,
    abonos_periodo: abonosPeriodoOffline,
    flujo_caja: importePagado + abonosPeriodoOffline,
    promedio_ventas_x_dias: cantidadVentas.size / diasVenta,
    promedio_ganancias_x_dias: ganancia / diasVenta,
  };

  renderizarMetricas(metricasLocales);
}

function renderizarMetricas(m) {
  document.getElementById("dash-cant-ventas").innerText = m.cantidad_ventas;
  document.getElementById("dash-cant-prods").innerText =
    m.cant_productos_vendidos;
  document.getElementById("dash-dias-venta").innerText = m.dias_de_venta || 0;

  // Mapeo de nuevas variables financieras
  document.getElementById("dash-ingresos-pagados").innerText = `$${(
    m.importe_pagado || 0
  ).toFixed(2)}`;
  document.getElementById(
    "dash-ventas-credito"
  ).innerText = `$${m.importe_credito.toFixed(2)}`;
  document.getElementById("dash-inversion").innerText = `$${m.inversion.toFixed(
    2
  )}`;
  document.getElementById("dash-ganancia").innerText = `$${m.ganancia.toFixed(
    2
  )}`;

  // Mapeo Cuentas por Cobrar
  document.getElementById(
    "dash-deuda-total"
  ).innerText = `$${m.deuda_total.toFixed(2)}`;
  document.getElementById(
    "dash-abonos"
  ).innerText = `$${m.abonos_periodo.toFixed(2)}`;
  document.getElementById(
    "dash-flujo-caja"
  ).innerText = `$${m.flujo_caja.toFixed(2)}`;

  // Omitimos promedios visualmente en el HTML modificado, pero si decides mantener la tarjeta:
  const elPromVentas = document.getElementById("dash-prom-ventas");
  if (elPromVentas)
    elPromVentas.innerText = m.promedio_ventas_x_dias.toFixed(2);

  const elPromGanancia = document.getElementById("dash-prom-ganancia");
  if (elPromGanancia)
    elPromGanancia.innerText = `$${m.promedio_ganancias_x_dias.toFixed(2)}`;

  // NUEVO: Renderizar tabla de deudores
  const tbody = document.getElementById("body-deudores");
  if (tbody) {
    tbody.innerHTML = "";
    if (m.listado_deudores && m.listado_deudores.length > 0) {
      m.listado_deudores.forEach((d) => {
        tbody.innerHTML += `
                       <tr style="border-bottom: 1px solid #eee;">
                           <td style="padding: 8px;">${d.nombre}</td>
                           <td style="padding: 8px;">${d.telefono}</td>
                           <td style="padding: 8px; color: var(--danger-color); font-weight: bold;">$${d.deuda.toFixed(
                             2
                           )}</td>
                           <td style="padding: 8px;">${d.productos}</td>
                           <td style="padding: 8px; text-align: center; font-weight: bold;">${
                             d.dias_pendientes
                           }</td>
                       </tr>
                   `;
      });
    } else {
      tbody.innerHTML =
        '<tr><td colspan="5" style="padding: 15px; text-align: center; color: gray;">No hay clientes con deuda pendiente.</td></tr>';
    }
  }

  const tbodyProductos = document.getElementById("body-productos-vendidos");
  if (tbodyProductos) {
    tbodyProductos.innerHTML = "";
    if (m.desglose_productos && m.desglose_productos.length > 0) {
      m.desglose_productos.forEach((p) => {
        tbodyProductos.innerHTML += `
                       <tr style="border-bottom: 1px solid #eee;">
                           <td style="padding: 8px;">${p.nombre}</td>
                           <td style="padding: 8px; text-align: center; font-weight: bold;">${
                             p.cantidad
                           }</td>
                           <td style="padding: 8px; color: var(--primary-color); font-weight: bold;">$${p.importe.toFixed(
                             2
                           )}</td>
                       </tr>
                   `;
      });
    } else {
      tbodyProductos.innerHTML =
        '<tr><td colspan="3" style="padding: 15px; text-align: center; color: gray;">No hay productos vendidos en este periodo.</td></tr>';
    }
  }
}

function cargarDatosSecundariosDashboard() {
  let ventasPendientes =
    JSON.parse(localStorage.getItem("ventasPendientes")) || [];
  let bajoStock = 0;
  let agotados = 0;

  catalogoLocal.forEach((prod) => {
    if (prod.existencia > 0 && prod.existencia <= 5) bajoStock++;
    else if (prod.existencia <= 0) agotados++;
  });

  document.getElementById("dash-ventas-cola").innerText =
    ventasPendientes.length;
  document.getElementById("dash-bajostock").innerText = bajoStock;
  document.getElementById("dash-agotados").innerText = agotados;
}

function renderizarListaClientes() {
  const datalist = document.getElementById("lista-clientes");
  datalist.innerHTML = "";
  clientesLocal.forEach((cli) => {
    const option = document.createElement("option");
    option.value = cli.nombre;
    datalist.appendChild(option);
  });
}

function verificarClienteNuevo() {
  const nombreInput = document.getElementById("cliente-credito").value.trim();

  // 🛠️ NUEVO: Función para normalizar texto (quita espacios extra, minúsculas y acentos)
  const normalizar = (texto) => {
    return String(texto || "") // Convierte a texto y evita errores si el dato es nulo
      .trim() // Quita espacios al inicio y al final
      .toLowerCase() // Pasa todo a minúsculas
      .normalize("NFD") // Separa las letras de sus acentos
      .replace(/[\u0300-\u036f]/g, ""); // Elimina los acentos
  };

  // 🔍 Aplicamos la normalización tanto a la base de datos como a lo que escribe el usuario
  const clienteExistente = clientesLocal.find(
    (c) => normalizar(c.nombre) === normalizar(nombreInput)
  );

  const divNuevoCliente = document.getElementById("nuevo-cliente-campos");
  const estadoDeuda = document.getElementById("estado-deuda");

  if (nombreInput === "") {
    divNuevoCliente.style.display = "none";
    estadoDeuda.style.display = "none";
    return;
  }

  estadoDeuda.style.display = "block";

  if (clienteExistente) {
    divNuevoCliente.style.display = "none";
    let disponible = clienteExistente.limite - clienteExistente.deuda;
    estadoDeuda.innerText = `🟢 Deuda: $${clienteExistente.deuda.toFixed(
      2
    )} | Disponible: $${disponible.toFixed(2)}`;

    // Estilos para cliente existente
    if (disponible > 0) {
      estadoDeuda.style.backgroundColor = "#d4edda";
      estadoDeuda.style.color = "#155724";
      estadoDeuda.style.borderColor = "#c3e6cb";
    } else {
      estadoDeuda.style.backgroundColor = "#f8d7da";
      estadoDeuda.style.color = "#721c24";
      estadoDeuda.style.borderColor = "#f5c6cb";
    }
  } else {
    // Estilos para avisar que es cliente nuevo
    divNuevoCliente.style.display = "block";
    estadoDeuda.innerText =
      "⚠️ Cliente no encontrado en base de datos. Complete el registro abajo.";
    estadoDeuda.style.backgroundColor = "#fff3cd";
    estadoDeuda.style.color = "#856404";
    estadoDeuda.style.borderColor = "#ffeeba";
  }
}

async function sincronizarClientesPendientes() {
  let clientesPendientes =
    JSON.parse(localStorage.getItem("clientesPendientes")) || [];

  // Si no hay clientes nuevos en cola, salimos
  if (clientesPendientes.length === 0) return;

  try {
    const payload = {
      action: "sincronizar_clientes",
      payload: { clientes: clientesPendientes },
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (data.success) {
      // Si el servidor confirmó que los guardó, limpiamos la cola local
      localStorage.removeItem("clientesPendientes");
      console.log("Clientes nuevos sincronizados con éxito en Google Sheets.");
    } else {
      console.warn("El servidor rechazó la sincronización de clientes:", data);
    }
  } catch (error) {
    console.warn(
      "Fallo al sincronizar clientes. Se intentará en segundo plano más tarde.",
      error
    );
  }
}

// ==========================================
// MÓDULO DE ABONOS (SOPORTE OFFLINE AÑADIDO)
// ==========================================
function abrirModalAbono() {
  // ELIMINADO: El bloqueo que impedía abrir el modal sin internet
  const select = document.getElementById("abono-cliente");
  select.innerHTML = '<option value="">Seleccione un cliente...</option>';

  const clientesConDeuda = clientesLocal.filter((c) => c.deuda > 0);

  if (clientesConDeuda.length === 0) {
    mostrarToast(
      "No hay clientes con deudas pendientes actualmente.",
      "success"
    );
    return;
  }

  clientesConDeuda.forEach((c) => {
    select.innerHTML += `<option value="${c.id}">${c.nombre}</option>`;
  });

  document.getElementById("modal-abono").style.display = "flex";
  document.getElementById("abono-monto").value = "";
  document.getElementById("badge-deuda-abono").style.display = "none";
}

function actualizarBadgeDeudaAbono() {
  const idCliente = document.getElementById("abono-cliente").value;
  const badge = document.getElementById("badge-deuda-abono");

  if (!idCliente) {
    badge.style.display = "none";
    return;
  }

  const cliente = clientesLocal.find((c) => c.id === idCliente);

  if (cliente) {
    badge.style.display = "block";
    badge.innerText = `🔴 Deuda Actual: $${cliente.deuda.toFixed(2)}`;
    badge.style.backgroundColor = "#fff3cd";
    badge.style.color = "#856404";
    badge.style.borderColor = "#ffeeba";
  }
}

async function ejecutarAbono() {
  const idCliente = document.getElementById("abono-cliente").value;
  const monto = parseFloat(document.getElementById("abono-monto").value);
  const metodo = document.getElementById("abono-metodo").value;

  if (!idCliente) return mostrarToast("Seleccione un cliente.", "warning");
  if (!monto || monto <= 0)
    return mostrarToast("Ingrese un monto válido.", "warning");

  const clienteIndex = clientesLocal.findIndex((c) => c.id === idCliente);
  const cliente = clientesLocal[clienteIndex];

  if (monto > cliente.deuda) {
    return mostrarToast(
      `El monto ingresado excede la deuda actual ($${cliente.deuda}).`,
      "error"
    );
  }

  // 1. IMPACTO LOCAL INMEDIATO (Funciona online y offline)
  clientesLocal[clienteIndex].deuda -= monto;
  localStorage.setItem("clientesLocal", JSON.stringify(clientesLocal));

  const nuevoAbono = {
    id_cliente: idCliente,
    monto: monto,
    metodo: metodo,
    tpv: instanciaActual,
    fecha: new Date().toISOString(),
  };

  // 2. ENCOLAR ABONO EN LOCALSTORAGE
  let abonosPendientes =
    JSON.parse(localStorage.getItem("abonosPendientes")) || [];
  abonosPendientes.push(nuevoAbono);
  localStorage.setItem("abonosPendientes", JSON.stringify(abonosPendientes));

  // 3. SINCRONIZAR O AVISAR
  if (navigator.onLine) {
    mostrarLoading("Registrando abono...");
    await sincronizarAbonosPendientes();
    ocultarLoading();
    mostrarToast("Abono registrado y sincronizado exitosamente.", "success");
  } else {
    mostrarToast(
      "Abono registrado en modo OFFLINE. Se sincronizará al recuperar la conexión.",
      "warning"
    );
  }

  if (metodo === 'efectivo') {
    turnoActual.abonosEfectivo += monto;
    localStorage.setItem('turnoActual', JSON.stringify(turnoActual));
}


  // Limpieza de UI
  cerrarModal("modal-abono");
  document.getElementById("abono-monto").value = "";
  verificarClienteNuevo(); // Actualiza visualmente si el cliente estaba seleccionado en la caja
}

async function sincronizarAbonosPendientes() {
  let abonosPendientes =
    JSON.parse(localStorage.getItem("abonosPendientes")) || [];
  if (abonosPendientes.length === 0) return;

  try {
    const payload = {
      action: "sincronizar_abonos",
      payload: { abonos: abonosPendientes },
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();

    if (data.success) {
      localStorage.removeItem("abonosPendientes");
      console.log("Abonos offline sincronizados con éxito.");
    }
  } catch (error) {
    console.warn(
      "Fallo al sincronizar abonos. Se reintentará en segundo plano.",
      error
    );
  }
}

function abrirModalEgreso() {
    if (!turnoActual) return mostrarToast("Caja no aperturada.", "warning");
    document.getElementById('egreso-monto').value = '';
    document.getElementById('egreso-concepto').value = '';
    document.getElementById('modal-egreso').style.display = 'flex';
}

//Egresos y Retiros
function ejecutarEgreso() {
  const tipo = document.getElementById('egreso-tipo').value;
  const monto = parseFloat(document.getElementById('egreso-monto').value);
  const concepto = document.getElementById('egreso-concepto').value;

  if (!monto || monto <= 0) return mostrarToast("Ingrese un monto válido", "error");
  if (!concepto) return mostrarToast("Ingrese un concepto", "error");

  // 🔴 NUEVA VALIDACIÓN: CALCULAR EFECTIVO DISPONIBLE Y PREVENIR SOBREGIRO
  const efectivoDisponible = (turnoActual.fondoInicial + turnoActual.ventasEfectivo + turnoActual.abonosEfectivo) - turnoActual.retiros;
  
  if (monto > efectivoDisponible) {
      return mostrarToast(`Fondos insuficientes. Solo dispone de $${efectivoDisponible.toFixed(2)} en efectivo.`, "error");
  }

  // Descontar del turno local
  turnoActual.retiros += monto;
  localStorage.setItem('turnoActual', JSON.stringify(turnoActual));

  // Encolar egreso
  let egresosPendientes = JSON.parse(localStorage.getItem('egresosPendientes')) || [];
  egresosPendientes.push({
      tpv: instanciaActual,
      fecha: new Date().toISOString(),
      tipo: tipo,
      monto: monto,
      concepto: concepto
  });
  localStorage.setItem('egresosPendientes', JSON.stringify(egresosPendientes));

  cerrarModal('modal-egreso');
  mostrarToast("Retiro registrado correctamente", "success");
  
  if (navigator.onLine) sincronizarEgresos();
}


async function sincronizarEgresos() {
  let egresosPendientes = JSON.parse(localStorage.getItem('egresosPendientes')) || [];
  if (egresosPendientes.length === 0) return;

  try {
      const payload = {
          action: 'registrar_egreso',
          payload: { egresos: egresosPendientes }
      };
      const response = await fetch(API_URL, {
          method: "POST",
          body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (data.success) {
          localStorage.removeItem('egresosPendientes');
          console.log("Egresos sincronizados con éxito.");
      }
  } catch (error) {
      console.warn("Fallo al sincronizar egresos. Se reintentará más tarde.", error);
  }
}



// ==========================================
// SISTEMA DE NOTIFICACIONES PERSONALIZADAS
// ==========================================

/**
 * Reemplaza a mostrarToast()
 * @param {string} mensaje - El texto a mostrar
 * @param {string} tipo - 'success', 'error', 'warning', 'info'
 */
function mostrarToast(mensaje, tipo = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${tipo}`;
  toast.innerText = mensaje;

  container.appendChild(toast);

  // Eliminar el elemento del DOM después de que termine la animación (aprox 4s)
  setTimeout(() => {
    if (container.contains(toast)) {
      container.removeChild(toast);
    }
  }, 4000);
}

// 🛠️ FUNCIÓN AUXILIAR: Normaliza texto eliminando acentos, espacios extra y mayúsculas
const normalizarTexto = (texto) => {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
};

// MODIFICADO: Asegurar actualización del catálogo al quitar elementos desde el bloque del carrito
const originalEliminarDelCarrito = eliminarDelCarrito;
eliminarDelCarrito = function (id) {
  originalEliminarDelCarrito(id);
  filtrarCatalogo(); // Mantiene sincronizado el badge numérico de la tarjeta
};

const originalRestarDelCarrito = restarDelCarrito;
restarDelCarrito = function (id) {
  originalRestarDelCarrito(id);
  filtrarCatalogo();
};

/**
 * Reemplaza a confirm() utilizando Promesas
 * @param {string} mensaje - Pregunta a confirmar
 * @returns {Promise<boolean>}
 */
function mostrarConfirmacion(mensaje) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-confirm");
    const btnYes = document.getElementById("btn-confirm-yes");
    const btnNo = document.getElementById("btn-confirm-no");

    document.getElementById("confirm-message").innerText = mensaje;
    modal.style.display = "flex";

    // Lógica para resolver la promesa y limpiar los eventos
    const cleanAndResolve = (result) => {
      modal.style.display = "none";
      btnYes.removeEventListener("click", onYes);
      btnNo.removeEventListener("click", onNo);
      resolve(result);
    };

    const onYes = () => cleanAndResolve(true);
    const onNo = () => cleanAndResolve(false);

    btnYes.addEventListener("click", onYes);
    btnNo.addEventListener("click", onNo);
  });
}

async function sincronizarCierresPendientes() {
  let cierresPendientes = JSON.parse(localStorage.getItem('cierresPendientes')) || [];
  if (cierresPendientes.length === 0) return;

  try {
      const payload = {
          action: 'registrar_cierre_caja',
          payload: { cierres: cierresPendientes }
      };
      const response = await fetch(API_URL, {
          method: "POST",
          body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (data.success) {
          localStorage.removeItem('cierresPendientes');
          console.log("Cierre de caja sincronizado con éxito.");
      }
  } catch (error) {
      console.warn("Fallo al sincronizar el cierre de caja. Se intentará más tarde.", error);
  }
}

async function cargarNombreTPV() {
  if (!navigator.onLine) return; // Si está offline, usará el que ya está en localStorage
  
  try {
    const payload = {
      action: "obtener_nombre_tpv",
      payload: { instancia: instanciaActual }
    };
    const response = await fetch(API_URL, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    
    if (data.success) {
      // Guardar en local para uso offline y para el ticket
      localStorage.setItem("nombreTPV", data.data.nombre);
      // Opcional: Actualizar el título de la interfaz
      document.getElementById("instancia-nombre").innerText = data.data.nombre;
    }
  } catch (error) {
    console.warn("No se pudo obtener el nombre del TPV. Se usará el código por defecto.");
  }
}

function generarTicketVenta(idVenta, carritoVenta, total, pagado, vuelto, metodoPago, clienteNombre = "") {
  let nombreComercial = localStorage.getItem("nombreTPV") || instanciaActual;
  let ventanaImpresion = window.open('', '_blank');
  
  if (!ventanaImpresion) {
      mostrarToast("Comprobante no generado: Desactive el bloqueador de ventanas emergentes.", "warning");
      return; 
  }

  let fecha = new Date().toLocaleString('es-ES');
  
  // Generar lista de artículos
  let itemsHTML = carritoVenta.map(item => `
      <div style="display:flex; justify-content:space-between; font-size: 12px; margin-bottom: 3px;">
          <span>${item.cantidad}x ${item.nombre}</span>
          <span>$${(item.precio * item.cantidad).toFixed(2)}</span>
      </div>
  `).join('');

  // Formato HTML del ticket adaptado a 58mm/80mm
  let html = `
      <div style="font-family: monospace; width: 300px; padding: 5px; color: black; background: white;">
          <h2 style="text-align: center; margin-bottom: 5px; font-size: 18px;">${nombreComercial}</h2>
          <p style="text-align: center; margin: 0; font-size: 12px;">Ticket: ${idVenta}</p>
          <p style="text-align: center; margin: 0; font-size: 12px;">Fecha: ${fecha}</p>
          ${clienteNombre ? `<p style="text-align: center; margin: 0; font-size: 12px;">Cliente: ${clienteNombre}</p>` : ''}
          
          <hr style="border-top: 1px dashed black; margin: 10px 0;">
          ${itemsHTML}
          <hr style="border-top: 1px dashed black; margin: 10px 0;">
          
          <div style="display:flex; justify-content:space-between; font-weight:bold; font-size: 14px;">
              <span>TOTAL:</span>
              <span>$${total.toFixed(2)}</span>
          </div>
          
          <div style="display:flex; justify-content:space-between; font-size: 12px; margin-top: 8px;">
              <span>Método:</span>
              <span>${metodoPago.toUpperCase()}</span>
          </div>
          
          ${metodoPago !== 'credito' ? `
          <div style="display:flex; justify-content:space-between; font-size: 12px;">
              <span>Recibido:</span>
              <span>$${pagado.toFixed(2)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size: 12px;">
              <span>Vuelto:</span>
              <span>$${vuelto.toFixed(2)}</span>
          </div>` : ''}
          
          <br>
          <p style="text-align: center; font-size: 12px; margin-top: 10px;">¡Gracias por su compra!</p>
      </div>
      <script>
          window.onload = function() { 
            window.print(); 
            setTimeout(() => window.close(), 500); 
          };
      </script>
  `;
  
  ventanaImpresion.document.write(html);
  ventanaImpresion.document.close();
}

// ==========================================
// CONTADOR DE BILLETES (CIERRE DE CAJA)
// ==========================================
function calcularTotalBilletes() {
  let total = 0;
  // Captura todos los inputs que pertenecen al contador de billetes
  const inputsBilletes = document.querySelectorAll('.calc-billete');
  
  inputsBilletes.forEach(input => {
      const cantidad = parseInt(input.value) || 0;
      const valorDenominacion = parseFloat(input.getAttribute('data-valor')) || 0;
      
      // Multiplica la cantidad de billetes por su denominación y suma al total
      total += (cantidad * valorDenominacion);
  });

  // Actualiza dinámicamente el input de efectivo declarado
  const inputDeclarado = document.getElementById('efectivo-declarado');
  inputDeclarado.value = total > 0 ? total.toFixed(2) : '';
}

function limpiarContadorBilletes() {
  const inputsBilletes = document.querySelectorAll('.calc-billete');
  inputsBilletes.forEach(input => input.value = '');
  document.getElementById('efectivo-declarado').value = '';
}
