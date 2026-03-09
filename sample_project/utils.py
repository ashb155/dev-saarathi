def is_number(value):
    try:
        float(value)
        return True
    except ValueError:
        return False

def format_result(result):
    if result == int(result):
        return int(result)
    return round(result, 6)

def history_log(operation, result, history=None):
    if history is None:
        history = []
    history.append(f"{operation} = {result}")
    return history