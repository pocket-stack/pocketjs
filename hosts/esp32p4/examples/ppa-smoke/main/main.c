#include "esp_err.h"
#include "pocketjs_ppa.h"

void app_main(void)
{
    pocketjs_ppa_handle_t ppa = NULL;
    ESP_ERROR_CHECK(pocketjs_ppa_create(&ppa));
    pocketjs_ppa_destroy(ppa);
}
